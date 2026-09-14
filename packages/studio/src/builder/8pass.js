const fs = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");

const { generatePrompts } = require("../lib/claude");
const { trainCharacterLora } = require("./character-lock");
const { extractSceneFrames } = require("./scene-lock");
const { synthesizeVoice } = require("./voice-lock");
const { generateCaptions } = require("./captions");

const CLIP_COUNT = 8;
const MIN_RUNTIME = 480;
const MAX_RUNTIME = 495;

function defaultFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function defaultProbe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`ffprobe failed: ${stderr || err.message}`));
          return;
        }
        resolve(parseFloat(String(stdout).trim()));
      },
    );
  });
}

async function loadState(stateFile) {
  if (!stateFile) return null;
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function saveState(stateFile, state) {
  if (!stateFile) return;
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Carry continuity data from a finished clip into the next clip's firstFrame.
 *
 * The engine returns `lastFrame`, but Wan2GP's sliding-window generation also
 * returns `overlappingFrames`. The multi-frame overlap is what the spec locks
 * continuity on, so prefer it and fall back to the single frame.
 */
async function carryFrames(result) {
  if (Array.isArray(result?.overlappingFrames)) {
    const { frameData } = await extractSceneFrames(result);
    return frameData.map((f) => f.dataUri);
  }
  if (result?.lastFrame) {
    return [result.lastFrame];
  }
  throw new Error("engine returned neither overlappingFrames nor lastFrame");
}

async function writeVideo(video, destination) {
  if (Buffer.isBuffer(video)) {
    await fs.writeFile(destination, video);
    return destination;
  }
  if (typeof video === "string") {
    // Already a path on disk — reference it in place.
    await fs.access(video);
    return video;
  }
  throw new Error("engine returned a video that is neither a Buffer nor a path");
}

/**
 * Run the full 8-pass build: prompts -> character -> voice -> captions ->
 * 8 generated clips -> concatenated mp4.
 *
 * Resumable: completed clips are recorded in `stateFile` and skipped on re-run.
 * A failure at clip K persists progress through K-1 and throws naming K; it
 * never emits a truncated mp4.
 *
 * @returns {Promise<{videoPath, srtPath, duration, clips}>}
 */
async function runEightPass({
  story,
  characterImages,
  referenceAudio,
  outputDir,
  stateFile,
  engine = require("../engines"),
  ffmpeg = defaultFfmpeg,
  probeDuration = defaultProbe,
  onProgress = () => {},
}) {
  if (!outputDir) throw new Error("outputDir is required");

  await fs.mkdir(outputDir, { recursive: true });
  const resolvedState = stateFile || path.join(outputDir, "state.json");
  const state = (await loadState(resolvedState)) || { clips: [] };

  // 1. Prompts (C4)
  if (!state.prompts) {
    state.prompts = await generatePrompts(story);
    await saveState(resolvedState, state);
  }
  const prompts = state.prompts;

  // 2. Character lock (C2)
  if (!state.soulId) {
    const { soulId } = await trainCharacterLora(characterImages);
    state.soulId = soulId;
    await saveState(resolvedState, state);
  }

  // 3. Voice (C5) — synthesizeVoice caches per clip internally
  if (!state.audioPaths) {
    state.audioPaths = await synthesizeVoice(
      referenceAudio,
      prompts.map((p) => p.voiceDirection),
    );
    await saveState(resolvedState, state);
  }

  // 4. Captions (C6)
  const srtPath = path.join(outputDir, "captions.srt");
  if (!state.srtWritten) {
    await fs.writeFile(srtPath, await generateCaptions(prompts));
    state.srtWritten = true;
    await saveState(resolvedState, state);
  }

  // 5. Generate the 8 clips in order, threading continuity frames forward.
  for (let i = 0; i < CLIP_COUNT; i++) {
    if (state.clips[i]?.status === "complete") {
      onProgress({ clip: i + 1, total: CLIP_COUNT, status: "cached" });
      continue;
    }

    const firstFrame = i > 0 ? state.clips[i - 1].carryFrames[0] : null;

    try {
      const result = await engine.generate({
        prompt: prompts[i].fullPrompt,
        firstFrame,
        soulId: state.soulId,
        voiceId: state.soulId,
      });

      const videoPath = await writeVideo(
        result.video,
        path.join(outputDir, `clip_${i}.mp4`),
      );

      state.clips[i] = {
        index: i,
        status: "complete",
        videoPath,
        audioPath: result.audioPath || state.audioPaths[i],
        carryFrames: await carryFrames(result),
      };
      await saveState(resolvedState, state);
      onProgress({ clip: i + 1, total: CLIP_COUNT, status: "complete" });
    } catch (error) {
      state.failedAt = i;
      await saveState(resolvedState, state);
      throw new Error(`8-pass failed at clip ${i}: ${error.message}`);
    }
  }

  delete state.failedAt;
  await saveState(resolvedState, state);

  // 6. Concat video, concat audio, then mux the two together.
  const videoList = path.join(outputDir, "videos.txt");
  const audioList = path.join(outputDir, "audios.txt");
  const concatLine = (p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`;

  await fs.writeFile(
    videoList,
    state.clips.map((c) => concatLine(c.videoPath)).join("\n"),
  );
  await fs.writeFile(
    audioList,
    state.clips.map((c) => concatLine(c.audioPath)).join("\n"),
  );

  const silentVideo = path.join(outputDir, "video_track.mp4");
  const mergedAudio = path.join(outputDir, "audio_track.wav");
  const finalVideo = path.join(outputDir, "final.mp4");

  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", videoList, "-c", "copy", "-an", silentVideo]);
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", audioList, "-c", "copy", mergedAudio]);
  await ffmpeg([
    "-y",
    "-i", silentVideo,
    "-i", mergedAudio,
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    finalVideo,
  ]);

  const duration = await probeDuration(finalVideo);
  if (!(duration >= MIN_RUNTIME && duration <= MAX_RUNTIME)) {
    throw new Error(
      `Final video is ${duration}s, outside the required ${MIN_RUNTIME}-${MAX_RUNTIME}s range`,
    );
  }

  return { videoPath: finalVideo, srtPath, duration, clips: state.clips };
}

module.exports = { runEightPass, CLIP_COUNT };
