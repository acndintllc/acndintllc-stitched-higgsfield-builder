const fs = require("fs").promises;
const path = require("path");
const os = require("os");

jest.mock("../src/lib/claude");
jest.mock("../src/builder/character-lock");
jest.mock("../src/builder/voice-lock");

const { generatePrompts } = require("../src/lib/claude");
const { trainCharacterLora } = require("../src/builder/character-lock");
const { synthesizeVoice } = require("../src/builder/voice-lock");
const { runEightPass, CLIP_COUNT } = require("../src/builder/8pass");

function samplePrompts() {
  return Array.from({ length: CLIP_COUNT }, (_, i) => ({
    character: "Mira",
    scene: `flooded avenue ${i}`,
    voiceDirection: "tense",
    fullPrompt: `<character>Mira</character><scene>avenue ${i}</scene><voice_direction>tense</voice_direction>`,
  }));
}

/** An engine whose clip N returns frames the next call must receive. */
function makeEngine(overrides = {}) {
  const calls = [];
  return {
    calls,
    generate: jest.fn(async (params) => {
      calls.push(params);
      const i = calls.length - 1;
      if (overrides.failAt === i) {
        throw new Error("GPU out of memory");
      }
      return {
        video: Buffer.from(`video-${i}`),
        overlappingFrames: Array.from(
          { length: 6 },
          (_, f) => `data:image/png;base64,${Buffer.from(`clip${i}frame${f}`).toString("base64")}`,
        ),
        audioPath: `/voice_cache/clip_${i}.wav`,
      };
    }),
  };
}

describe("8-Pass Engine + Concat (C7)", () => {
  let outputDir;
  let ffmpeg;
  let probeDuration;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "8pass-"));
    ffmpeg = jest.fn(async () => "");
    probeDuration = jest.fn(async () => 483.2);

    generatePrompts.mockResolvedValue(samplePrompts());
    trainCharacterLora.mockResolvedValue({
      soulId: "soul-abc",
      loraPath: "/lora_cache/soul-abc.safetensors",
    });
    synthesizeVoice.mockResolvedValue(
      Array.from({ length: CLIP_COUNT }, (_, i) => `/voice_cache/v_${i}.wav`),
    );
  });

  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  const run = (extra = {}) =>
    runEightPass({
      story: "A courier crosses a flooded city.",
      characterImages: ["/img/a.png", "/img/b.png", "/img/c.png"],
      referenceAudio: "/audio/reference.wav",
      outputDir,
      ffmpeg,
      probeDuration,
      ...extra,
    });

  test("produces all 8 clips in order", async () => {
    const engine = makeEngine();
    const result = await run({ engine });

    expect(engine.generate).toHaveBeenCalledTimes(CLIP_COUNT);
    expect(result.clips).toHaveLength(CLIP_COUNT);
    result.clips.forEach((clip, i) => {
      expect(clip.index).toBe(i);
      expect(clip.status).toBe("complete");
    });
    engine.calls.forEach((call, i) => {
      expect(call.prompt).toContain(`avenue ${i}`);
    });
  });

  test("clip N+1 first frame is carried from clip N overlap frames", async () => {
    const engine = makeEngine();
    await run({ engine });

    expect(engine.calls[0].firstFrame).toBeNull();
    for (let i = 1; i < CLIP_COUNT; i++) {
      const expected = Buffer.from(`clip${i - 1}frame0`).toString("base64");
      expect(engine.calls[i].firstFrame).toContain(expected);
    }
  });

  test("falls back to lastFrame when the engine returns no overlap frames", async () => {
    const engine = {
      generate: jest.fn(async () => ({
        video: Buffer.from("v"),
        lastFrame: "data:image/png;base64,QUJD",
        audioPath: "/voice_cache/a.wav",
      })),
    };

    await run({ engine });

    expect(engine.generate.mock.calls[1][0].firstFrame).toBe(
      "data:image/png;base64,QUJD",
    );
  });

  test("passes a stable soulId to every generation call", async () => {
    const engine = makeEngine();
    await run({ engine });

    for (const call of engine.calls) {
      expect(call.soulId).toBe("soul-abc");
    }
  });

  test("writes a sidecar .srt covering the video", async () => {
    const result = await run({ engine: makeEngine() });

    const srt = await fs.readFile(result.srtPath, "utf8");
    expect(result.srtPath).toMatch(/captions\.srt$/);
    expect(srt).toContain("00:00:00,000 -->");
    expect(srt).toContain("00:08:00,000");
  });

  test("muxes concatenated video with concatenated audio", async () => {
    await run({ engine: makeEngine() });

    const commands = ffmpeg.mock.calls.map((c) => c[0]);
    expect(commands).toHaveLength(3);

    const [videoConcat, audioConcat, mux] = commands;
    expect(videoConcat).toContain("concat");
    expect(videoConcat).toContain("-an");
    expect(audioConcat).toContain("concat");
    expect(mux).toContain("-c:a");
    expect(mux[mux.length - 1]).toMatch(/final\.mp4$/);

    const listFile = await fs.readFile(path.join(outputDir, "videos.txt"), "utf8");
    expect(listFile.split("\n")).toHaveLength(CLIP_COUNT);
  });

  test("returns a final video inside the 480-495s window", async () => {
    const result = await run({ engine: makeEngine() });

    expect(result.videoPath).toMatch(/final\.mp4$/);
    expect(result.duration).toBeGreaterThanOrEqual(480);
    expect(result.duration).toBeLessThanOrEqual(495);
  });

  test("rejects a final video outside the runtime window", async () => {
    probeDuration.mockResolvedValue(122);

    await expect(run({ engine: makeEngine() })).rejects.toThrow(
      /outside the required 480-495s range/,
    );
  });

  test("reports progress for each clip", async () => {
    const onProgress = jest.fn();
    await run({ engine: makeEngine(), onProgress });

    expect(onProgress).toHaveBeenCalledTimes(CLIP_COUNT);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      clip: 1,
      total: 8,
      status: "complete",
    });
    expect(onProgress).toHaveBeenNthCalledWith(8, {
      clip: 8,
      total: 8,
      status: "complete",
    });
  });

  describe("failure handling", () => {
    test("failure at clip K names K and emits no final video", async () => {
      const engine = makeEngine({ failAt: 3 });

      await expect(run({ engine })).rejects.toThrow(/failed at clip 3/);

      await expect(
        fs.access(path.join(outputDir, "final.mp4")),
      ).rejects.toThrow();
      expect(ffmpeg).not.toHaveBeenCalled();
    });

    test("failure persists progress through clip K-1", async () => {
      await expect(run({ engine: makeEngine({ failAt: 3 }) })).rejects.toThrow();

      const state = JSON.parse(
        await fs.readFile(path.join(outputDir, "state.json"), "utf8"),
      );
      expect(state.failedAt).toBe(3);
      expect(state.clips.filter((c) => c?.status === "complete")).toHaveLength(3);
    });
  });

  describe("resumability", () => {
    test("re-run resumes at the failed clip instead of restarting", async () => {
      await expect(run({ engine: makeEngine({ failAt: 3 }) })).rejects.toThrow();

      const resumeEngine = makeEngine();
      const result = await run({ engine: resumeEngine });

      // Clips 0-2 were already on disk, so only 5 remain.
      expect(resumeEngine.generate).toHaveBeenCalledTimes(CLIP_COUNT - 3);
      expect(result.clips).toHaveLength(CLIP_COUNT);
    });

    test("re-run reports cached clips as cached", async () => {
      await expect(run({ engine: makeEngine({ failAt: 3 }) })).rejects.toThrow();

      const onProgress = jest.fn();
      await run({ engine: makeEngine(), onProgress });

      const statuses = onProgress.mock.calls.map((c) => c[0].status);
      expect(statuses.slice(0, 3)).toEqual(["cached", "cached", "cached"]);
    });

    test("a fully cached re-run calls the engine zero times", async () => {
      await run({ engine: makeEngine() });

      const secondEngine = makeEngine();
      await run({ engine: secondEngine });

      expect(secondEngine.generate).not.toHaveBeenCalled();
      expect(generatePrompts).toHaveBeenCalledTimes(1);
      expect(trainCharacterLora).toHaveBeenCalledTimes(1);
    });
  });

  test("requires an outputDir", async () => {
    await expect(
      runEightPass({ story: "x", outputDir: null }),
    ).rejects.toThrow(/outputDir is required/);
  });
});
