/**
 * Muapi Fallback Engine
 *
 * Wraps existing muapi.js to provide the standard engine interface.
 * Used as fallback when Wan2GP is unavailable.
 *
 * Expected muapi.js interface:
 *   - submit(prompt, firstFrame, soulId, voiceId) => Promise<jobId>
 *   - poll(jobId, maxAttempts?, pollInterval?) => Promise<result>
 */

const muapi = require('../muapi');

/**
 * Extract last frame from muapi result
 */
function extractLastFrame(muapiResult) {
  // Muapi might return: { frames: [...], lastFrame: ... } or { video_frames: [...] }
  if (muapiResult.frames && Array.isArray(muapiResult.frames) && muapiResult.frames.length > 0) {
    return muapiResult.frames[muapiResult.frames.length - 1];
  }

  if (muapiResult.lastFrame) {
    return muapiResult.lastFrame;
  }

  if (muapiResult.last_frame) {
    return muapiResult.last_frame;
  }

  // Fallback: if frames array exists, use last element
  if (muapiResult.video_frames && Array.isArray(muapiResult.video_frames)) {
    return muapiResult.video_frames[muapiResult.video_frames.length - 1] || null;
  }

  throw new Error('Unable to extract last frame from muapi result');
}

/**
 * Main generate function
 */
async function generate({ prompt, firstFrame = null, soulId, voiceId }) {
  if (!prompt || !soulId || !voiceId) {
    throw new Error('Missing required params: prompt, soulId, voiceId');
  }

  try {
    // Submit job via muapi
    const jobId = await muapi.submit(prompt, firstFrame, soulId, voiceId);
    console.log(`[Muapi] Submitted job: ${jobId}`);

    // Poll for completion
    const result = await muapi.poll(jobId);
    console.log(`[Muapi] Job ${jobId} completed`);

    // Extract outputs
    const lastFrame = extractLastFrame(result);
    const audioPath = result.audio_path || result.audioPath || result.audio;

    if (!result.video && !result.video_path && !result.videoPath) {
      throw new Error('Muapi result missing video output');
    }

    return {
      video: result.video || result.video_path || result.videoPath,
      lastFrame,
      audioPath
    };
  } catch (error) {
    console.error('[Muapi] Generation failed:', error.message);
    throw error;
  }
}

module.exports = {
  generate
};
