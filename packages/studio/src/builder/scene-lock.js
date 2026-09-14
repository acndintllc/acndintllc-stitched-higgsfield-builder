const fetch = require("node-fetch");

/**
 * Extract overlapping frames from Wan2GP FLF2V (First-Last-Frame-to-Video) response.
 *
 * FLF2V endpoint generates a video from first and last frames, and returns
 * intermediate frames that overlap between clips. These frames are used as
 * the firstFrame input for the next clip to ensure visual continuity.
 *
 * @param {object} wan2gpResponse - Response from FLF2V endpoint
 * @param {Buffer} wan2gpResponse.video - MP4 video bytes
 * @param {Array<string|object>} wan2gpResponse.overlappingFrames - Array of frame data (base64 or image objects)
 * @returns {Promise<{frameData: Array, frameCount: number}>} Extracted frame data and count
 * @throws {Error} If overlappingFrames is missing or has insufficient frames
 *
 * Frame data structure can be:
 * - Base64 strings: "data:image/png;base64,..."
 * - Objects: {frameIndex: number, base64: "...", timestamp: number}
 * - Raw image buffers (will be converted to base64)
 */
async function extractSceneFrames(wan2gpResponse) {
  // Validate input
  if (!wan2gpResponse || typeof wan2gpResponse !== "object") {
    throw new Error("wan2gpResponse must be a valid object");
  }

  if (!wan2gpResponse.overlappingFrames) {
    throw new Error("wan2gpResponse must include overlappingFrames array");
  }

  if (!Array.isArray(wan2gpResponse.overlappingFrames)) {
    throw new Error("overlappingFrames must be an array");
  }

  const frameCount = wan2gpResponse.overlappingFrames.length;

  // Validate minimum frame count (5-10 minimum)
  if (frameCount < 5) {
    throw new Error(
      `Insufficient frames: got ${frameCount}, minimum 5 required for scene continuity`,
    );
  }

  // Extract and normalize frame data
  const frameData = await Promise.all(
    wan2gpResponse.overlappingFrames.map(async (frame, index) => {
      // Handle different frame data formats
      let frameBase64;
      let frameIndex = index;
      let timestamp = null;

      if (typeof frame === "string") {
        // Already a base64 string (with or without data URI prefix)
        frameBase64 = frame.includes("base64,")
          ? frame.split("base64,")[1]
          : frame;
      } else if (typeof frame === "object" && frame !== null) {
        // Object with properties
        if (frame.base64) {
          frameBase64 = frame.base64.includes("base64,")
            ? frame.base64.split("base64,")[1]
            : frame.base64;
        } else if (frame.data) {
          // Raw buffer or array
          frameBase64 = Buffer.isBuffer(frame.data)
            ? frame.data.toString("base64")
            : Buffer.from(frame.data).toString("base64");
        } else {
          throw new Error(
            `Frame object must have 'base64' or 'data' property at index ${index}`,
          );
        }

        // Preserve metadata if present
        if (typeof frame.frameIndex === "number") {
          frameIndex = frame.frameIndex;
        }
        if (typeof frame.timestamp === "number") {
          timestamp = frame.timestamp;
        }
      } else if (Buffer.isBuffer(frame)) {
        // Raw buffer
        frameBase64 = frame.toString("base64");
      } else {
        throw new Error(
          `Frame at index ${index} must be a string, object, or buffer`,
        );
      }

      return {
        frameIndex,
        base64: frameBase64,
        timestamp,
        dataUri: `data:image/png;base64,${frameBase64}`,
      };
    }),
  );

  return {
    frameData,
    frameCount,
  };
}

/**
 * Call Wan2GP FLF2V endpoint to generate video with scene lock.
 *
 * @param {object} options
 * @param {string|Buffer} options.firstFrame - First frame (image file path or buffer)
 * @param {string|Buffer} options.lastFrame - Last frame (image file path or buffer)
 * @param {string} options.prompt - Video generation prompt
 * @param {string} [options.endpoint="http://127.0.0.1:7860"] - Wan2GP API endpoint
 * @returns {Promise<object>} Response with video and overlappingFrames
 */
async function generateSceneLockedVideo({
  firstFrame,
  lastFrame,
  prompt,
  endpoint = "http://127.0.0.1:7860",
}) {
  // Validate inputs
  if (!firstFrame || !lastFrame) {
    throw new Error("firstFrame and lastFrame are required");
  }

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }

  // Convert frame data to base64 if necessary
  let firstFrameBase64 = firstFrame;
  let lastFrameBase64 = lastFrame;

  if (Buffer.isBuffer(firstFrame)) {
    firstFrameBase64 = firstFrame.toString("base64");
  }
  if (Buffer.isBuffer(lastFrame)) {
    lastFrameBase64 = lastFrame.toString("base64");
  }

  // Call FLF2V endpoint
  const flf2vUrl = `${endpoint}/api/call/generate_flf2v`;

  try {
    const response = await fetch(flf2vUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstFrame: firstFrameBase64,
        lastFrame: lastFrameBase64,
        prompt,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `FLF2V API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = await response.json();
    return data;
  } catch (error) {
    throw new Error(`Failed to generate scene-locked video: ${error.message}`);
  }
}

module.exports = {
  extractSceneFrames,
  generateSceneLockedVideo,
};
