const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");

/**
 * Compute deterministic soulId from sorted image bytes.
 * Same images (in any order) = same soulId
 * @param {string[]} imageFiles - paths to image files
 * @returns {Promise<string>} SHA256 hash of concatenated sorted image bytes
 */
async function computeSoulId(imageFiles) {
  // Validate input
  if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
    throw new Error("imageFiles must be a non-empty array");
  }

  const fileContents = await Promise.all(
    imageFiles.map((filePath) => fs.readFile(filePath)),
  );

  // Sort by content to ensure deterministic hash regardless of input order
  const sortedContents = fileContents.sort((a, b) => Buffer.compare(a, b));

  // Concatenate and hash
  const concatenated = Buffer.concat(sortedContents);
  const hash = crypto.createHash("sha256").update(concatenated).digest("hex");

  return hash;
}

/**
 * Poll Wan2GP endpoint until training is complete.
 * @param {string} trainingId - training job ID from initial POST
 * @param {number} maxWaitMs - max time to wait (default 15 minutes)
 * @returns {Promise<object>} training result with weights path
 */
async function pollTrainingStatus(trainingId, maxWaitMs = 15 * 60 * 1000) {
  const pollIntervalMs = 5000; // Poll every 5 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(
        `http://127.0.0.1:7860/api/lora/status/${trainingId}`,
        { method: "GET" },
      );

      if (!response.ok) {
        throw new Error(`Status check failed: ${response.statusCode}`);
      }

      const data = await response.json();

      if (data.status === "completed") {
        return data;
      }

      if (data.status === "failed") {
        throw new Error(
          `LoRA training failed: ${data.error || "unknown error"}`,
        );
      }

      // Still pending, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    } catch (error) {
      throw new Error(`Failed to poll training status: ${error.message}`);
    }
  }

  throw new Error(`LoRA training timeout after ${maxWaitMs}ms`);
}

/**
 * Train a LoRA model on reference character images.
 * Returns deterministic soulId and path to persisted weights.
 *
 * @param {string[]} imageFiles - array of image file paths (3-5 recommended)
 * @returns {Promise<{soulId: string, loraPath: string}>}
 *
 * Flow:
 * 1. Compute deterministic soulId from sorted image bytes
 * 2. POST image refs to Wan2GP /api/lora/train endpoint
 * 3. Poll /api/lora/status/{trainingId} until complete
 * 4. Save weights to ./lora_cache/{soulId}.safetensors
 * 5. Return {soulId, loraPath}
 *
 * Note: Training typically takes 5-15 minutes. Polling is built-in.
 */
async function trainCharacterLora(imageFiles) {
  // Validate input
  if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
    throw new Error("imageFiles must be a non-empty array");
  }

  if (imageFiles.length > 10) {
    throw new Error("Maximum 10 images allowed");
  }

  // Compute deterministic soulId
  const soulId = await computeSoulId(imageFiles);

  // Ensure cache directory exists
  const cacheDir = path.resolve(process.cwd(), "lora_cache");
  try {
    await fs.mkdir(cacheDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create lora_cache directory: ${error.message}`);
  }

  const loraPath = path.join(cacheDir, `${soulId}.safetensors`);

  // Check if already trained
  try {
    await fs.access(loraPath);
    // File exists, return cached result
    return { soulId, loraPath };
  } catch {
    // File doesn't exist, proceed with training
  }

  // POST to Wan2GP
  let trainingId;
  try {
    const response = await fetch("http://127.0.0.1:7860/api/lora/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageFiles,
        soulId, // Include soulId in request for server-side tracking
      }),
    });

    if (!response.ok) {
      throw new Error(
        `API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json();
    trainingId = data.trainingId;

    if (!trainingId) {
      throw new Error("Server did not return trainingId");
    }
  } catch (error) {
    throw new Error(`Failed to initiate LoRA training: ${error.message}`);
  }

  // Poll until complete
  let trainingResult;
  try {
    trainingResult = await pollTrainingStatus(trainingId);
  } catch (error) {
    throw new Error(`Training polling failed: ${error.message}`);
  }

  // Save weights to cache
  if (trainingResult.weightsBase64) {
    try {
      const weightsBuffer = Buffer.from(trainingResult.weightsBase64, "base64");
      await fs.writeFile(loraPath, weightsBuffer);
    } catch (error) {
      throw new Error(`Failed to save LoRA weights: ${error.message}`);
    }
  } else if (trainingResult.weightsPath) {
    // Server may return a path; copy it to our cache
    try {
      const sourceWeights = await fs.readFile(trainingResult.weightsPath);
      await fs.writeFile(loraPath, sourceWeights);
    } catch (error) {
      throw new Error(
        `Failed to copy LoRA weights from server: ${error.message}`,
      );
    }
  } else {
    throw new Error("Training result did not include weights");
  }

  return { soulId, loraPath };
}

module.exports = {
  trainCharacterLora,
  computeSoulId,
  pollTrainingStatus,
};
