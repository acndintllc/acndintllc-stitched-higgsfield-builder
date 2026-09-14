const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");

/**
 * Compute deterministic voiceId from reference audio bytes.
 * Same audio (in any form) = same voiceId
 * @param {Buffer} audioBuffer - raw audio file content
 * @returns {string} SHA256 hash of audio bytes
 */
function computeVoiceId(audioBuffer) {
  // Validate input
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error("audioBuffer must be a non-empty Buffer");
  }

  const hash = crypto.createHash("sha256").update(audioBuffer).digest("hex");
  return hash;
}

/**
 * Synthesize voice from reference audio and text prompts.
 * 1. POST reference audio to voice clone endpoint → get voiceId
 * 2. For each of 8 prompts: POST to TTS endpoint with voiceId + text → get .wav
 * 3. Save 8 .wav files to ./voice_cache/
 * 4. Return array of file paths
 *
 * @param {string} referenceAudioPath - path to reference audio file
 * @param {string[]} prompts - array of 8 text prompts to synthesize
 * @returns {Promise<string[]>} array of paths to generated .wav files
 *
 * Audio specs (locked):
 * - Format: .wav
 * - Sample rate: 44.1kHz
 * - Channels: mono
 * - Bitrate: 16-bit PCM
 */
async function synthesizeVoice(referenceAudioPath, prompts) {
  // Validate input
  if (typeof referenceAudioPath !== "string") {
    throw new Error("referenceAudioPath must be a string");
  }

  if (!Array.isArray(prompts) || prompts.length !== 8) {
    throw new Error("prompts must be an array of exactly 8 strings");
  }

  if (!prompts.every((p) => typeof p === "string" && p.length > 0)) {
    throw new Error("all prompts must be non-empty strings");
  }

  // Read reference audio
  let referenceBuffer;
  try {
    referenceBuffer = await fs.readFile(referenceAudioPath);
  } catch (error) {
    throw new Error(`Failed to read reference audio: ${error.message}`);
  }

  // Compute deterministic voiceId
  const voiceId = computeVoiceId(referenceBuffer);

  // Ensure cache directory exists
  const cacheDir = path.resolve(
    process.env.VOICE_CACHE_DIR || path.join(process.cwd(), "voice_cache"),
  );
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create voice_cache directory: ${error.message}`);
  }

  const outputPaths = prompts.map((_, i) =>
    path.join(cacheDir, `${voiceId}_prompt_${i}.wav`),
  );

  // A fully cached voice needs no GPU round-trip at all, so resolve the cache
  // before cloning rather than per-prompt inside the synthesis loop.
  const cached = await Promise.all(
    outputPaths.map((p) =>
      fs.access(p).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (cached.every(Boolean)) {
    return outputPaths;
  }

  // Clone voice
  let clonedVoiceId;
  try {
    const response = await fetch("http://127.0.0.1:7860/api/call/voice_clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        referenceAudio: referenceBuffer.toString("base64"),
        voiceId, // Include voiceId for server-side tracking
      }),
    });

    if (!response.ok) {
      throw new Error(
        `API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json();
    clonedVoiceId = data.voiceId;

    if (!clonedVoiceId) {
      throw new Error("Server did not return voiceId");
    }
  } catch (error) {
    throw new Error(`Failed to clone voice: ${error.message}`);
  }

  // Synthesize each prompt
  const voicePaths = [];

  for (let i = 0; i < prompts.length; i++) {
    const promptText = prompts[i];
    const outputFile = outputPaths[i];

    if (cached[i]) {
      voicePaths.push(outputFile);
      continue;
    }

    try {
      const response = await fetch("http://127.0.0.1:7860/api/call/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voiceId: clonedVoiceId,
          text: promptText,
          // Audio specs (locked)
          sampleRate: 44100, // 44.1kHz
          channels: 1, // mono
          bitDepth: 16, // 16-bit PCM
        }),
      });

      if (!response.ok) {
        throw new Error(
          `TTS API returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      const audioBytes = data.audio_bytes || data.audio;

      if (!audioBytes) {
        throw new Error("Server did not return audio bytes");
      }

      // Decode base64 or handle raw bytes
      const audioBuffer =
        typeof audioBytes === "string"
          ? Buffer.from(audioBytes, "base64")
          : Buffer.from(audioBytes);

      // Save to cache
      await fs.writeFile(outputFile, audioBuffer);
      voicePaths.push(outputFile);
    } catch (error) {
      throw new Error(`Failed to synthesize prompt ${i}: ${error.message}`);
    }
  }

  return voicePaths;
}

module.exports = {
  synthesizeVoice,
  computeVoiceId,
};
