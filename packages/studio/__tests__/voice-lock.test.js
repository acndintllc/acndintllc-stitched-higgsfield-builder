const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

/**
 * Test fixtures and mocks
 */

// Mock fetch for testing without actual network calls
const mockFetch = jest.fn();
jest.mock("node-fetch", () => mockFetch);

// Must require AFTER jest.mock
const {
  synthesizeVoice,
  computeVoiceId,
} = require("../src/builder/voice-lock");

describe("Voice Lock via TTS (C5)", () => {
  let testDir;
  let referenceAudio;
  // A full 60s clip is ~5.3MB of PCM; generating and base64-encoding one per
  // mock blew the default 5s timeout, so build it once and share the bytes.
  let clip60s;
  let clip60sBase64;
  let cacheCounter = 0;

  beforeAll(async () => {
    // Setup test directory
    testDir = path.join(__dirname, "fixtures", "voice-test");
    await fs.mkdir(testDir, { recursive: true });

    // Generate reference audio (2-second silence)
    referenceAudio = generateWavFile(44100, 1, 2, 0);
    const refPath = path.join(testDir, "reference.wav");
    await fs.writeFile(refPath, referenceAudio);

    clip60s = generateWavFile(44100, 1, 60, 0);
    clip60sBase64 = clip60s.toString("base64");
  });

  afterAll(async () => {
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      await fs.rm(path.join(process.cwd(), "voice_cache"), {
        recursive: true,
        force: true,
      });
    } catch (e) {
      // ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // Each test gets its own cache dir. A test that times out leaves its
    // writes running, and a shared dir let those land as "cached" results
    // for whichever test ran next.
    const cacheDir = path.join(testDir, `voice_cache-${cacheCounter++}`);
    process.env.VOICE_CACHE_DIR = cacheDir;
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch (e) {
      // ignore cleanup errors
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("computeVoiceId", () => {
    test("same audio produces same voiceId (determinism)", () => {
      const id1 = computeVoiceId(referenceAudio);
      const id2 = computeVoiceId(referenceAudio);
      expect(id1).toBe(id2);
    });

    test("different audio produces different voiceIds", () => {
      const audio1 = generateWavFile(44100, 1, 2, 0);
      const audio2 = generateWavFile(44100, 1, 2, 1);
      const id1 = computeVoiceId(audio1);
      const id2 = computeVoiceId(audio2);
      expect(id1).not.toBe(id2);
    });

    test("voiceId is a valid SHA256 hex string", () => {
      const id = computeVoiceId(referenceAudio);
      expect(id).toMatch(/^[a-f0-9]{64}$/); // SHA256 = 64 hex chars
    });

    test("throws on empty buffer", () => {
      expect(() => computeVoiceId(Buffer.alloc(0))).toThrow();
    });

    test("throws on non-buffer input", () => {
      expect(() => computeVoiceId("not a buffer")).toThrow();
      expect(() => computeVoiceId(null)).toThrow();
    });
  });

  describe("synthesizeVoice", () => {
    test("successful synthesis returns 8 file paths", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = [
        "Hello world",
        "This is a test",
        "Voice synthesis",
        "Prompt four",
        "Prompt five",
        "Prompt six",
        "Prompt seven",
        "Prompt eight",
      ];

      const expectedVoiceId = computeVoiceId(referenceAudio);

      // Mock voice clone response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          voiceId: `cloned-${expectedVoiceId.slice(0, 16)}`,
        }),
      });

      // Mock 8 TTS responses (60 seconds of silence each)
      for (let i = 0; i < 8; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            audio_bytes: clip60sBase64,
          }),
        });
      }

      const result = await synthesizeVoice(refPath, prompts);

      expect(result).toHaveLength(8);
      expect(result.every((p) => typeof p === "string")).toBe(true);
      expect(result.every((p) => p.includes("voice_cache"))).toBe(true);
      expect(result.every((p) => p.includes(".wav"))).toBe(true);
    });

    test("all 8 synthesized files exist and have correct size", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];

      // Mock voice clone
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voiceId: "test-voice-id" }),
      });

      // Mock 8 TTS responses
      for (let i = 0; i < 8; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            audio_bytes: clip60sBase64,
          }),
        });
      }

      const paths = await synthesizeVoice(refPath, prompts);

      // Verify all files exist
      for (const filePath of paths) {
        await expect(fs.access(filePath)).resolves.not.toThrow();
      }

      // Verify file sizes (60 seconds @ 44.1kHz, mono, 16-bit = 5,292,044 bytes + WAV header)
      for (const filePath of paths) {
        const stat = await fs.stat(filePath);
        // WAV header (44 bytes) + 60s of audio data
        // 44100 samples/sec * 60 sec * 2 bytes/sample = 5,292,000 bytes
        // Total ~5,292,044 bytes (with header)
        expect(stat.size).toBeGreaterThan(5000000);
        expect(stat.size).toBeLessThan(6000000);
      }
    });

    test("returns cached files if already synthesized", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];

      // Pre-create cached files
      const voiceId = computeVoiceId(referenceAudio);
      const cacheDir = path.resolve(process.env.VOICE_CACHE_DIR);
      await fs.mkdir(cacheDir, { recursive: true });

      const cachedPaths = [];
      for (let i = 0; i < 8; i++) {
        const filePath = path.join(cacheDir, `${voiceId}_prompt_${i}.wav`);
        await fs.writeFile(filePath, clip60s);
        cachedPaths.push(filePath);
      }

      // synthesizeVoice should return cached files without calling fetch
      const result = await synthesizeVoice(refPath, prompts);

      expect(result).toEqual(cachedPaths);
      expect(mockFetch).not.toHaveBeenCalled(); // No network call
    });

    test("throws on invalid referenceAudioPath", async () => {
      const prompts = Array(8).fill("test");

      await expect(synthesizeVoice(null, prompts)).rejects.toThrow(
        /referenceAudioPath must be a string/,
      );
    });

    test("throws on invalid prompts (not array)", async () => {
      const refPath = path.join(testDir, "reference.wav");

      await expect(synthesizeVoice(refPath, null)).rejects.toThrow(
        /prompts must be an array/,
      );

      await expect(synthesizeVoice(refPath, "single string")).rejects.toThrow(
        /prompts must be an array/,
      );
    });

    test("throws on wrong number of prompts", async () => {
      const refPath = path.join(testDir, "reference.wav");

      await expect(synthesizeVoice(refPath, ["only", "7"])).rejects.toThrow(
        /exactly 8 strings/,
      );

      await expect(
        synthesizeVoice(refPath, Array(9).fill("test")),
      ).rejects.toThrow(/exactly 8 strings/);
    });

    test("throws on empty prompt strings", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");
      prompts[3] = ""; // Empty string

      await expect(synthesizeVoice(refPath, prompts)).rejects.toThrow(
        /non-empty strings/,
      );
    });

    test("throws on missing reference audio file", async () => {
      const prompts = Array(8).fill("test");

      await expect(
        synthesizeVoice("/nonexistent/audio.wav", prompts),
      ).rejects.toThrow(/Failed to read reference audio/);
    });

    test("handles voice clone API errors gracefully", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(synthesizeVoice(refPath, prompts)).rejects.toThrow(
        /Failed to clone voice/,
      );
    });

    test("handles missing voiceId from clone response", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}), // Missing voiceId
      });

      await expect(synthesizeVoice(refPath, prompts)).rejects.toThrow(
        /did not return voiceId/,
      );
    });

    test("handles TTS API errors gracefully", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      // Mock successful voice clone
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voiceId: "test-voice" }),
      });

      // Mock TTS failure on first prompt
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      await expect(synthesizeVoice(refPath, prompts)).rejects.toThrow(
        /Failed to synthesize prompt 0/,
      );
    });

    test("handles missing audio bytes from TTS response", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      // Mock successful voice clone
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voiceId: "test-voice" }),
      });

      // Mock TTS response without audio bytes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}), // Missing audio_bytes
      });

      await expect(synthesizeVoice(refPath, prompts)).rejects.toThrow(
        /did not return audio bytes/,
      );
    });

    test("audio specs are enforced (44.1kHz, mono, 16-bit)", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voiceId: "test-voice" }),
      });

      for (let i = 0; i < 8; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            audio_bytes: clip60sBase64,
          }),
        });
      }

      const paths = await synthesizeVoice(refPath, prompts);

      // Verify WAV format of first file
      const firstAudio = await fs.readFile(paths[0]);
      const wavInfo = parseWavHeader(firstAudio);

      expect(wavInfo.sampleRate).toBe(44100);
      expect(wavInfo.numChannels).toBe(1); // mono
      expect(wavInfo.bitsPerSample).toBe(16);
    });

    test("integration: voiceId is deterministic across calls", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voiceId: "deterministic-voice" }),
      });

      for (let i = 0; i < 8; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            audio_bytes: clip60sBase64,
          }),
        });
      }

      const paths = await synthesizeVoice(refPath, prompts);

      // voiceId should be:
      // - deterministic (same reference audio = same voiceId)
      // - included in all output paths
      const voiceId = computeVoiceId(referenceAudio);
      expect(paths.every((p) => p.includes(voiceId))).toBe(true);
    });
  });

  describe("Error scenarios", () => {
    test("partial TTS success should fail entire batch", async () => {
      const refPath = path.join(testDir, "reference.wav");
      const prompts = Array(8).fill("test");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voiceId: "test-voice" }),
      });

      // Successful responses for prompts 0-2
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            audio_bytes: clip60sBase64,
          }),
        });
      }

      // Failure on prompt 3
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(synthesizeVoice(refPath, prompts)).rejects.toThrow();
    });
  });
});

/**
 * Helper: Generate a valid WAV file (RIFF/WAVE format).
 * Audio specs (locked):
 * - Sample rate: 44.1kHz
 * - Channels: 1 (mono)
 * - Bitrate: 16-bit PCM
 *
 * @param {number} sampleRate - sample rate in Hz (44100 = 44.1kHz)
 * @param {number} numChannels - number of channels (1 = mono)
 * @param {number} durationSeconds - duration in seconds
 * @param {number} seed - seed for sample data variation
 * @returns {Buffer} complete WAV file
 */
function generateWavFile(sampleRate, numChannels, durationSeconds, seed = 0) {
  const bytesPerSample = 2; // 16-bit = 2 bytes
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * numChannels * bytesPerSample;

  // WAV header
  const header = Buffer.alloc(44);
  let offset = 0;

  // RIFF header
  header.write("RIFF", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(36 + dataSize, offset); // file size - 8
  offset += 4;
  header.write("WAVE", offset, "ascii");
  offset += 4;

  // fmt sub-chunk
  header.write("fmt ", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(16, offset); // sub-chunk size (16 for PCM)
  offset += 4;
  header.writeUInt16LE(1, offset); // audio format (1 = PCM)
  offset += 2;
  header.writeUInt16LE(numChannels, offset);
  offset += 2;
  header.writeUInt32LE(sampleRate, offset);
  offset += 4;
  header.writeUInt32LE(sampleRate * numChannels * bytesPerSample, offset); // byte rate
  offset += 4;
  header.writeUInt16LE(numChannels * bytesPerSample, offset); // block align
  offset += 2;
  header.writeUInt16LE(16, offset); // bits per sample
  offset += 2;

  // data sub-chunk
  header.write("data", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(dataSize, offset);

  // Sample data (silence = all zeros)
  const sampleData = Buffer.alloc(dataSize);

  // Optionally vary with seed (for determinism in testing)
  if (seed !== 0) {
    for (let i = 0; i < sampleData.length; i += 2) {
      const sample = Math.sin((i * seed) / 1000) * 100; // Very quiet variation
      sampleData.writeInt16LE(Math.floor(sample), i);
    }
  }

  return Buffer.concat([header, sampleData]);
}

/**
 * Parse WAV file header to extract audio properties.
 * @param {Buffer} wavBuffer - raw WAV file buffer
 * @returns {object} { sampleRate, numChannels, bitsPerSample }
 */
function parseWavHeader(wavBuffer) {
  // Skip RIFF header (12 bytes) and fmt sub-chunk header (8 bytes)
  let offset = 20;

  // Read audio format properties
  const numChannels = wavBuffer.readUInt16LE(offset + 2);
  const sampleRate = wavBuffer.readUInt32LE(offset + 4);
  const bitsPerSample = wavBuffer.readUInt16LE(offset + 14);

  return { numChannels, sampleRate, bitsPerSample };
}
