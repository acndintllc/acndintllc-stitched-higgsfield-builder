/**
 * Scene Lock via FLF2V (First-Last-Frame-to-Video) Tests — C3
 *
 * Tests extractSceneFrames and generateSceneLockedVideo functions.
 * Validates frame extraction, continuity, and next-clip integration.
 */

// Mock fetch for testing without actual network calls
const mockFetch = jest.fn();
jest.mock("node-fetch", () => mockFetch);

// Must require AFTER jest.mock
const {
  extractSceneFrames,
  generateSceneLockedVideo,
} = require("../src/builder/scene-lock");

describe("Scene Lock via FLF2V (C3)", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("extractSceneFrames", () => {
    test("successfully extracts base64 string frames", async () => {
      const mockResponse = {
        video: Buffer.from("mock-video-data"),
        overlappingFrames: [
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        ],
      };

      const result = await extractSceneFrames(mockResponse);

      expect(result).toHaveProperty("frameData");
      expect(result).toHaveProperty("frameCount");
      expect(result.frameCount).toBe(6);
      expect(result.frameData).toHaveLength(6);

      // Verify frame structure
      result.frameData.forEach((frame, index) => {
        expect(frame).toHaveProperty("frameIndex", index);
        expect(frame).toHaveProperty("base64");
        expect(frame).toHaveProperty("dataUri");
        expect(frame.dataUri).toContain("data:image/png;base64,");
        expect(frame.timestamp).toBeNull();
      });
    });

    test("extracts frames with metadata objects", async () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: [
          {
            frameIndex: 0,
            base64: `data:image/png;base64,${base64Data}`,
            timestamp: 0,
          },
          {
            frameIndex: 1,
            base64: base64Data,
            timestamp: 1000,
          },
          {
            frameIndex: 2,
            base64: base64Data,
            timestamp: 2000,
          },
          {
            frameIndex: 3,
            base64: base64Data,
            timestamp: 3000,
          },
          {
            frameIndex: 4,
            base64: base64Data,
            timestamp: 4000,
          },
        ],
      };

      const result = await extractSceneFrames(mockResponse);

      expect(result.frameCount).toBe(5);
      expect(result.frameData[0].frameIndex).toBe(0);
      expect(result.frameData[0].timestamp).toBe(0);
      expect(result.frameData[1].timestamp).toBe(1000);
      expect(result.frameData[4].timestamp).toBe(4000);
    });

    test("handles raw base64 strings (no data URI prefix)", async () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: Array(5).fill(base64Data),
      };

      const result = await extractSceneFrames(mockResponse);

      expect(result.frameCount).toBe(5);
      result.frameData.forEach((frame) => {
        expect(frame.base64).toBe(base64Data);
        expect(frame.dataUri).toContain(base64Data);
      });
    });

    test("converts Buffer frame data to base64", async () => {
      const frameBuffer = Buffer.from("test-frame-data");
      const expectedBase64 = frameBuffer.toString("base64");

      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: [
          { data: frameBuffer },
          { data: frameBuffer },
          { data: frameBuffer },
          { data: frameBuffer },
          { data: frameBuffer },
        ],
      };

      const result = await extractSceneFrames(mockResponse);

      expect(result.frameCount).toBe(5);
      result.frameData.forEach((frame) => {
        expect(frame.base64).toBe(expectedBase64);
      });
    });

    test("validates minimum frame count (5 required)", async () => {
      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      // Test with 4 frames (insufficient)
      const insufficientFrames = {
        video: Buffer.from("mock-video"),
        overlappingFrames: [base64, base64, base64, base64],
      };

      await expect(extractSceneFrames(insufficientFrames)).rejects.toThrow(
        /Insufficient frames/,
      );
    });

    test("accepts 5+ frames (minimum requirement met)", async () => {
      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      // Test with exactly 5 frames
      const minFrames = {
        video: Buffer.from("mock-video"),
        overlappingFrames: Array(5).fill(base64),
      };

      const result = await extractSceneFrames(minFrames);
      expect(result.frameCount).toBe(5);

      // Test with 10 frames
      const maxFrames = {
        video: Buffer.from("mock-video"),
        overlappingFrames: Array(10).fill(base64),
      };

      const result2 = await extractSceneFrames(maxFrames);
      expect(result2.frameCount).toBe(10);
    });

    test("returns frame data suitable for next clip's firstFrame", async () => {
      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: Array(5).fill(base64),
      };

      const result = await extractSceneFrames(mockResponse);

      // Verify first frame can be used as next clip's input
      const firstFrame = result.frameData[0];
      expect(firstFrame.dataUri).toBeTruthy();
      expect(firstFrame.base64).toBeTruthy();
      expect(firstFrame.dataUri).toMatch(/^data:image\/png;base64,/);
    });

    test("preserves frame metadata through extraction", async () => {
      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: [
          {
            frameIndex: 5,
            base64: "dGVzdA==",
            timestamp: 1000,
          },
          {
            frameIndex: 6,
            base64: "dGVzdA==",
            timestamp: 2000,
          },
          {
            frameIndex: 7,
            base64: "dGVzdA==",
            timestamp: 3000,
          },
          {
            frameIndex: 8,
            base64: "dGVzdA==",
            timestamp: 4000,
          },
          {
            frameIndex: 9,
            base64: "dGVzdA==",
            timestamp: 5000,
          },
        ],
      };

      const result = await extractSceneFrames(mockResponse);

      expect(result.frameData[0].frameIndex).toBe(5);
      expect(result.frameData[1].frameIndex).toBe(6);
      expect(result.frameData[0].timestamp).toBe(1000);
      expect(result.frameData[4].timestamp).toBe(5000);
    });

    test("throws on invalid input (not an object)", async () => {
      await expect(extractSceneFrames(null)).rejects.toThrow();
      await expect(extractSceneFrames("invalid")).rejects.toThrow();
      await expect(extractSceneFrames(123)).rejects.toThrow();
    });

    test("throws on missing overlappingFrames", async () => {
      const mockResponse = {
        video: Buffer.from("mock-video"),
        // Missing overlappingFrames
      };

      await expect(extractSceneFrames(mockResponse)).rejects.toThrow(
        /overlappingFrames/,
      );
    });

    test("throws if overlappingFrames is not an array", async () => {
      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: "not-an-array",
      };

      await expect(extractSceneFrames(mockResponse)).rejects.toThrow(
        /must be an array/,
      );
    });

    test("throws on invalid frame object format", async () => {
      const mockResponse = {
        video: Buffer.from("mock-video"),
        overlappingFrames: [
          "data:image/png;base64,test",
          "data:image/png;base64,test",
          "data:image/png;base64,test",
          "data:image/png;base64,test",
          { invalidKey: "value" }, // Missing base64 or data
        ],
      };

      await expect(extractSceneFrames(mockResponse)).rejects.toThrow();
    });
  });

  describe("generateSceneLockedVideo", () => {
    test("calls FLF2V endpoint with correct parameters", async () => {
      const mockResponse = {
        video: Buffer.from("mock-video-bytes"),
        overlappingFrames: Array(5).fill(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        ),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const firstFrameBase64 = "test-first-frame-base64";
      const lastFrameBase64 = "test-last-frame-base64";
      const prompt = "A serene landscape transition";

      const result = await generateSceneLockedVideo({
        firstFrame: firstFrameBase64,
        lastFrame: lastFrameBase64,
        prompt,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:7860/api/call/generate_flf2v",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining(firstFrameBase64),
        }),
      );

      expect(result).toEqual(mockResponse);
    });

    test("accepts Buffer frames and converts to base64", async () => {
      const firstFrameBuffer = Buffer.from("first-frame-data");
      const lastFrameBuffer = Buffer.from("last-frame-data");
      const prompt = "Smooth transition";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          video: Buffer.from("video-data"),
          overlappingFrames: Array(5).fill("base64-frame"),
        }),
      });

      await generateSceneLockedVideo({
        firstFrame: firstFrameBuffer,
        lastFrame: lastFrameBuffer,
        prompt,
      });

      const callArgs = mockFetch.mock.calls[0];
      const bodyJson = JSON.parse(callArgs[1].body);

      expect(bodyJson.firstFrame).toBe(firstFrameBuffer.toString("base64"));
      expect(bodyJson.lastFrame).toBe(lastFrameBuffer.toString("base64"));
    });

    test("supports custom endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          video: Buffer.from("data"),
          overlappingFrames: Array(5).fill("frame"),
        }),
      });

      await generateSceneLockedVideo({
        firstFrame: "frame1",
        lastFrame: "frame2",
        prompt: "test",
        endpoint: "http://custom-endpoint:8080",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://custom-endpoint:8080/api/call/generate_flf2v",
        expect.any(Object),
      );
    });

    test("throws on missing required parameters", async () => {
      await expect(
        generateSceneLockedVideo({
          lastFrame: "frame",
          prompt: "test",
        }),
      ).rejects.toThrow(/firstFrame.*required/);

      await expect(
        generateSceneLockedVideo({
          firstFrame: "frame",
          prompt: "test",
        }),
      ).rejects.toThrow(/lastFrame.*required/);

      await expect(
        generateSceneLockedVideo({
          firstFrame: "frame",
          lastFrame: "frame",
        }),
      ).rejects.toThrow(/prompt/);
    });

    test("throws on empty prompt", async () => {
      await expect(
        generateSceneLockedVideo({
          firstFrame: "frame",
          lastFrame: "frame",
          prompt: "",
        }),
      ).rejects.toThrow(/non-empty string/);

      await expect(
        generateSceneLockedVideo({
          firstFrame: "frame",
          lastFrame: "frame",
          prompt: "   ",
        }),
      ).rejects.toThrow(/non-empty string/);
    });

    test("handles API errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        generateSceneLockedVideo({
          firstFrame: "f",
          lastFrame: "l",
          prompt: "test",
        }),
      ).rejects.toThrow(/Failed to generate scene-locked video/);
    });

    test("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      await expect(
        generateSceneLockedVideo({
          firstFrame: "f",
          lastFrame: "l",
          prompt: "test",
        }),
      ).rejects.toThrow(/Failed to generate scene-locked video/);
    });
  });

  describe("Integration: FLF2V → extractSceneFrames → next clip", () => {
    test("full pipeline: generate video and extract frames for next clip", async () => {
      // Step 1: Generate scene-locked video
      const mockFLF2VResponse = {
        video: Buffer.from("mock-video-mp4-bytes"),
        overlappingFrames: [
          {
            frameIndex: 0,
            base64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            timestamp: 0,
          },
          {
            frameIndex: 1,
            base64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            timestamp: 1000,
          },
          {
            frameIndex: 2,
            base64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            timestamp: 2000,
          },
          {
            frameIndex: 3,
            base64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            timestamp: 3000,
          },
          {
            frameIndex: 4,
            base64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            timestamp: 4000,
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockFLF2VResponse,
      });

      // Generate video
      const videoResponse = await generateSceneLockedVideo({
        firstFrame: "clip-1-last-frame",
        lastFrame: "clip-2-first-frame",
        prompt: "Smooth transition between scenes",
      });

      // Step 2: Extract frames for next clip
      const extractedFrames = await extractSceneFrames(videoResponse);

      expect(extractedFrames.frameCount).toBe(5);
      expect(extractedFrames.frameData).toHaveLength(5);

      // Step 3: Verify first extracted frame can be used as next clip's firstFrame
      const nextClipFirstFrame = extractedFrames.frameData[0];
      expect(nextClipFirstFrame.dataUri).toBeTruthy();
      expect(nextClipFirstFrame.base64).toBeTruthy();

      // Could continue to next iteration
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockFLF2VResponse,
      });

      const nextVideoResponse = await generateSceneLockedVideo({
        firstFrame: nextClipFirstFrame.dataUri,
        lastFrame: "clip-3-first-frame",
        prompt: "Continuing seamless transition",
      });

      expect(nextVideoResponse.overlappingFrames).toBeDefined();
    });
  });
});
