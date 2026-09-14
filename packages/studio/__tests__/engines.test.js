const { EventEmitter } = require("events");

jest.mock("http");

/**
 * Queue a sequence of JSON payloads to be returned by successive
 * http.request calls, mimicking Wan2GP's submit-then-poll flow.
 */
function queueResponses(httpMock, payloads) {
  const requests = [];
  httpMock.request.mockImplementation((options, callback) => {
    const payload = payloads[requests.length];
    requests.push(options);

    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => {
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(payload)));
      res.emit("end");
    });

    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn();
    return req;
  });
  return requests;
}

/**
 * resetModules rebuilds the http auto-mock, so the engine and the mock must be
 * pulled from the same post-reset registry or the stubs land on a dead copy.
 */
function loadEngine() {
  jest.resetModules();
  process.env.WAN2GP_POLL_INTERVAL = "1";
  const engine = require("../src/engines");
  return { engine, httpMock: require("http") };
}

describe("Engine Abstraction (C1)", () => {
  let warn;
  let log;
  let error;

  beforeEach(() => {
    jest.clearAllMocks();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    error = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  describe("interface", () => {
    test("exports generate and getCurrentEngine", () => {
      const { engine } = loadEngine();
      expect(typeof engine.generate).toBe("function");
      expect(typeof engine.getCurrentEngine).toBe("function");
    });

    test("reports wan2gp as the active backend", () => {
      expect(loadEngine().engine.getCurrentEngine()).toBe("wan2gp");
    });

    test("Muapi is no longer part of the engine layer", () => {
      const { engine } = loadEngine();
      expect(engine._muapi).toBeUndefined();
      expect(() => require("../src/engines/muapi-fallback")).toThrow();
    });

    test("ENGINE_MODE cannot route away from wan2gp", () => {
      process.env.ENGINE_MODE = "muapi";
      expect(loadEngine().engine.getCurrentEngine()).toBe("wan2gp");
      delete process.env.ENGINE_MODE;
    });
  });

  describe("generate", () => {
    test("submits a job then polls until completion", async () => {
      const { engine, httpMock } = loadEngine();
      const requests = queueResponses(httpMock, [
        { job_id: "job-1" },
        { status: "processing" },
        {
          status: "completed",
          video: "/out/clip.mp4",
          frames: ["frame-a", "frame-b", "frame-z"],
          audio_path: "/out/clip.wav",
        },
      ]);

      const result = await engine.generate({
        prompt: "a courier crosses a flooded city",
        soulId: "soul-1",
        voiceId: "voice-1",
      });

      expect(requests).toHaveLength(3);
      expect(requests[0].method).toBe("POST");
      expect(requests[0].path).toBe("/api/generate");
      expect(requests[1].method).toBe("GET");
      expect(requests[1].path).toBe("/api/generate/job-1");
      expect(result).toEqual({
        video: "/out/clip.mp4",
        lastFrame: "frame-z",
        audioPath: "/out/clip.wav",
      });
    });

    test("returns the documented output shape", async () => {
      const { engine, httpMock } = loadEngine();
      queueResponses(httpMock, [
        { job_id: "job-2" },
        { status: "completed", video_path: "/v.mp4", last_frame: "f", audioPath: "/a.wav" },
      ]);

      const result = await engine.generate({
        prompt: "p",
        soulId: "s",
        voiceId: "v",
      });

      expect(Object.keys(result).sort()).toEqual([
        "audioPath",
        "lastFrame",
        "video",
      ]);
    });

    test("forwards firstFrame only when provided", async () => {
      const { engine, httpMock } = loadEngine();
      const bodies = [];
      httpMock.request.mockImplementation((options, callback) => {
        const payloads = [
          { job_id: "job-3" },
          { status: "completed", video: "/v.mp4", last_frame: "f" },
        ];
        const payload = payloads[bodies.length];
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
          callback(res);
          res.emit("data", Buffer.from(JSON.stringify(payload)));
          res.emit("end");
        });
        const req = new EventEmitter();
        req.write = jest.fn((b) => bodies.push(JSON.parse(b)));
        req.end = jest.fn(() => {
          if (options.method === "GET") bodies.push({});
        });
        return req;
      });

      await engine.generate({
        prompt: "p",
        firstFrame: "data:image/png;base64,AAA",
        soulId: "s",
        voiceId: "v",
      });

      expect(bodies[0].first_frame).toBe("data:image/png;base64,AAA");
      expect(bodies[0].soul_id).toBe("s");
      expect(bodies[0].voice_id).toBe("v");
    });

    test("rejects missing required params", async () => {
      const { engine } = loadEngine();

      await expect(
        engine.generate({ soulId: "s", voiceId: "v" }),
      ).rejects.toThrow(/Missing required params/);
      await expect(
        engine.generate({ prompt: "p", voiceId: "v" }),
      ).rejects.toThrow(/Missing required params/);
      await expect(
        engine.generate({ prompt: "p", soulId: "s" }),
      ).rejects.toThrow(/Missing required params/);
    });

    test("throws when the queue reports a failed job", async () => {
      const { engine, httpMock } = loadEngine();
      queueResponses(httpMock, [
        { job_id: "job-4" },
        { status: "failed", error: "CUDA out of memory" },
      ]);

      await expect(
        engine.generate({ prompt: "p", soulId: "s", voiceId: "v" }),
      ).rejects.toThrow(/CUDA out of memory/);
    });

    test("throws when submit returns no job_id", async () => {
      const { engine, httpMock } = loadEngine();
      queueResponses(httpMock, [{}]);

      await expect(
        engine.generate({ prompt: "p", soulId: "s", voiceId: "v" }),
      ).rejects.toThrow(/did not return job_id/);
    });

    test("throws when the completed job has no video", async () => {
      const { engine, httpMock } = loadEngine();
      queueResponses(httpMock, [
        { job_id: "job-5" },
        { status: "completed", last_frame: "f" },
      ]);

      await expect(
        engine.generate({ prompt: "p", soulId: "s", voiceId: "v" }),
      ).rejects.toThrow(/missing video output/);
    });

    test("throws when the completed job has no frame data", async () => {
      const { engine, httpMock } = loadEngine();
      queueResponses(httpMock, [
        { job_id: "job-6" },
        { status: "completed", video: "/v.mp4" },
      ]);

      await expect(
        engine.generate({ prompt: "p", soulId: "s", voiceId: "v" }),
      ).rejects.toThrow(/No last_frame or frames array/);
    });
  });
});
