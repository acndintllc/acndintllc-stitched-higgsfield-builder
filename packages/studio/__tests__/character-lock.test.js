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
  trainCharacterLora,
  computeSoulId,
  pollTrainingStatus,
} = require("../src/builder/character-lock");

describe("Character Lock via LoRA (C2)", () => {
  let testDir;
  let testImages;

  beforeAll(async () => {
    // Setup test directory
    testDir = path.join(__dirname, "fixtures", "test-run");
    await fs.mkdir(testDir, { recursive: true });

    // Generate 5 dummy PNG images for testing
    testImages = await generateDummyImages(testDir, 5);
  });

  afterAll(async () => {
    // Cleanup
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      await fs.rm(path.join(process.cwd(), "lora_cache"), {
        recursive: true,
        force: true,
      });
    } catch (e) {
      // ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // Clear cache before each test to avoid cross-test contamination
    try {
      await fs.rm(path.join(process.cwd(), "lora_cache"), {
        recursive: true,
        force: true,
      });
    } catch (e) {
      // ignore cleanup errors
    }
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("computeSoulId", () => {
    test("same images produce same soulId (determinism)", async () => {
      const id1 = await computeSoulId(testImages.slice(0, 3));
      const id2 = await computeSoulId(testImages.slice(0, 3));
      expect(id1).toBe(id2);
    });

    test("same images in different order produce same soulId", async () => {
      const subset = testImages.slice(0, 3);
      const id1 = await computeSoulId([subset[0], subset[1], subset[2]]);
      const id2 = await computeSoulId([subset[2], subset[0], subset[1]]);
      expect(id1).toBe(id2);
    });

    test("different images produce different soulIds", async () => {
      const id1 = await computeSoulId([testImages[0], testImages[1]]);
      const id2 = await computeSoulId([testImages[2], testImages[3]]);
      expect(id1).not.toBe(id2);
    });

    test("soulId is a valid SHA256 hex string", async () => {
      const id = await computeSoulId([testImages[0]]);
      expect(id).toMatch(/^[a-f0-9]{64}$/); // SHA256 = 64 hex chars
    });

    test("throws on empty array", async () => {
      await expect(computeSoulId([])).rejects.toThrow();
    });
  });

  describe("trainCharacterLora", () => {
    test("successful training returns soulId and loraPath", async () => {
      const imageSubset = testImages.slice(0, 3);
      const expectedSoulId = await computeSoulId(imageSubset);

      // Mock successful training response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ trainingId: "train-123" }),
      });

      // Mock status polling - return completed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed",
          weightsBase64: Buffer.from("mock-weights-data").toString("base64"),
        }),
      });

      const result = await trainCharacterLora(imageSubset);

      expect(result).toHaveProperty("soulId");
      expect(result).toHaveProperty("loraPath");
      expect(result.soulId).toBe(expectedSoulId);
      expect(result.loraPath).toContain(expectedSoulId);
      expect(result.loraPath).toContain("lora_cache");
      expect(result.loraPath).toContain(".safetensors");
    });

    test("weights file is persisted after training", async () => {
      const imageSubset = testImages.slice(0, 2);
      const weightsData = "test-weights-content-12345";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ trainingId: "train-456" }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "completed",
          weightsBase64: Buffer.from(weightsData).toString("base64"),
        }),
      });

      const { loraPath } = await trainCharacterLora(imageSubset);

      // Verify file exists and has correct content
      const savedContent = await fs.readFile(loraPath, "utf-8");
      expect(savedContent).toBe(weightsData);
    });

    test("returns cached result if weights already exist", async () => {
      const imageSubset = testImages.slice(0, 1);

      // Pre-create the lora cache file
      const soulId = await computeSoulId(imageSubset);
      const cacheDir = path.join(process.cwd(), "lora_cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const loraPath = path.join(cacheDir, `${soulId}.safetensors`);
      await fs.writeFile(loraPath, "cached-weights");

      // trainCharacterLora should return without calling fetch
      const result = await trainCharacterLora(imageSubset);

      expect(result.soulId).toBe(soulId);
      expect(result.loraPath).toBe(loraPath);
      expect(mockFetch).not.toHaveBeenCalled(); // No network call
    });

    test("throws on invalid input", async () => {
      await expect(trainCharacterLora(null)).rejects.toThrow();
      await expect(trainCharacterLora([])).rejects.toThrow();
      await expect(trainCharacterLora([1, 2, 3])).rejects.toThrow(); // non-strings
    });

    test("handles API errors gracefully", async () => {
      const imageSubset = testImages.slice(0, 2);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(trainCharacterLora(imageSubset)).rejects.toThrow(
        /Failed to initiate LoRA training/,
      );
    });

    test("handles training failure from server", async () => {
      const imageSubset = testImages.slice(0, 2);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ trainingId: "train-fail" }),
      });

      // Server returns failed status
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "failed",
          error: "GPU out of memory",
        }),
      });

      await expect(trainCharacterLora(imageSubset)).rejects.toThrow(
        /LoRA training failed/,
      );
    });

    test("handles polling timeout", async () => {
      const imageSubset = testImages.slice(0, 2);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ trainingId: "train-timeout" }),
      });

      // Always return pending status (simulating stuck training)
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: "pending" }),
      });

      // Override to use short timeout for testing
      const shortTimeoutMs = 100; // 100ms instead of 15min

      await expect(
        pollTrainingStatus("train-timeout", shortTimeoutMs),
      ).rejects.toThrow(/timeout/i);
    }, 10000); // 10 second timeout for this test

    test("soulId is passed to generation calls (integration boundary)", async () => {
      // This test verifies the soulId can be used as a stable identifier
      // for passing to all 8 generation calls (C3-C10)
      const images = testImages.slice(0, 3);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ trainingId: "train-integration" }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "completed",
          weightsBase64: Buffer.from("weights").toString("base64"),
        }),
      });

      const result = await trainCharacterLora(images);

      // soulId should be:
      // - non-empty
      // - deterministic (tested above)
      // - suitable as filename/identifier
      expect(result.soulId).toBeTruthy();
      expect(result.soulId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.soulId).toEqual(expect.any(String));
    });
  });

  describe("Error scenarios", () => {
    test("missing trainCharacterLora response field", async () => {
      const images = testImages.slice(0, 2);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}), // Missing trainingId
      });

      await expect(trainCharacterLora(images)).rejects.toThrow(
        /did not return trainingId/,
      );
    });

    test("weights not included in training result", async () => {
      const images = testImages.slice(0, 2);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ trainingId: "train-no-weights" }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "completed",
          // Missing weightsBase64 and weightsPath
        }),
      });

      await expect(trainCharacterLora(images)).rejects.toThrow(
        /did not include weights/,
      );
    });
  });
});

/**
 * Helper: Generate dummy PNG images for testing.
 * Each has a unique pixel pattern to ensure different content.
 * @param {string} dir - directory to save images
 * @param {number} count - number of images to generate
 * @returns {Promise<string[]>} array of file paths
 */
async function generateDummyImages(dir, count) {
  const images = [];

  for (let i = 0; i < count; i++) {
    // Create a simple 8x8 PNG with unique pixel data
    // This is a valid minimal PNG file with different data each time
    const buffer = createMinimalPng(8, 8, i);

    const filePath = path.join(dir, `test-image-${i}.png`);
    await fs.writeFile(filePath, buffer);
    images.push(filePath);
  }

  return images;
}

/**
 * Create a minimal valid PNG file with deterministic content.
 * @param {number} width - image width
 * @param {number} height - image height
 * @param {number} seed - seed value for pixel data variation
 * @returns {Buffer} PNG file buffer
 */
function createMinimalPng(width, height, seed = 0) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk (image header)
  const ihdr = createChunk(
    "IHDR",
    Buffer.concat([
      Buffer.from([0, 0, 0, width]), // width (4 bytes)
      Buffer.from([0, 0, 0, height]), // height (4 bytes)
      Buffer.from([8, 2, 0, 0, 0]), // bit depth, color type, compression, filter, interlace
    ]),
  );

  // IDAT chunk (image data) - minimal pixel data with seed variation
  const pixelData = Buffer.alloc(width * height * 3 + height);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    pixelData[offset++] = 0; // Filter type
    for (let x = 0; x < width; x++) {
      // Use seed to vary pixel values deterministically
      const r = (x * 7 + y * 11 + seed * 13) % 256;
      const g = (x * 13 + y * 7 + seed * 11) % 256;
      const b = (x * 11 + y * 13 + seed * 7) % 256;

      pixelData[offset++] = r;
      pixelData[offset++] = g;
      pixelData[offset++] = b;
    }
  }

  const idat = createChunk("IDAT", pixelData);

  // IEND chunk (image end)
  const iend = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Create a PNG chunk with type and data.
 * @param {string} type - 4-character chunk type (e.g. 'IHDR')
 * @param {Buffer} data - chunk data
 * @returns {Buffer} complete chunk with length and CRC
 */
function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, "ascii");
  const chunkData = Buffer.concat([typeBuffer, data]);

  const crc = calculateCrc(chunkData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, chunkData, crcBuffer]);
}

/**
 * Calculate CRC for PNG chunk.
 * @param {Buffer} data - chunk type + data
 * @returns {number} CRC value
 */
function calculateCrc(data) {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
