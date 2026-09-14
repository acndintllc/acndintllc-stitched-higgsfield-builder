/**
 * Engine Abstraction Layer
 *
 * Wan2GP is the only backend. Muapi was dropped from the architecture: its
 * 18-second clip cap forces 27-96 clips per 8-minute video, which the
 * rented-GPU model replaces outright.
 *
 * Usage:
 *   const engine = require('./engines');
 *   const result = await engine.generate({
 *     prompt: "A person walking...",
 *     firstFrame: "/path/to/image.png",
 *     soulId: "soul_123",
 *     voiceId: "voice_456"
 *   });
 *   // Returns: { video, lastFrame, audioPath }
 */

const wan2gpEngine = require('./wan2gp');

const ENGINE_MODE = 'wan2gp';

/**
 * Get the active engine instance
 * @returns {Object} Engine with generate() method
 */
function getEngine() {
  return wan2gpEngine;
}

/**
 * Generate video using the active backend
 *
 * @param {Object} params
 * @param {string} params.prompt - Generation prompt
 * @param {string|null} params.firstFrame - Path or URL to first frame (optional)
 * @param {string} params.soulId - Soul identifier
 * @param {string} params.voiceId - Voice identifier
 *
 * @returns {Promise<Object>} { video, lastFrame, audioPath }
 *   - video: Raw video file (Buffer or path)
 *   - lastFrame: Final frame from generation (for sliding window)
 *   - audioPath: Path to audio file (.wav or .m4a)
 */
async function generate({ prompt, firstFrame = null, soulId, voiceId }) {
  const engine = getEngine();

  if (!engine || typeof engine.generate !== 'function') {
    throw new Error('Engine not initialized or missing generate method');
  }

  return engine.generate({
    prompt,
    firstFrame,
    soulId,
    voiceId
  });
}

/**
 * Get current engine mode (for testing/debugging)
 */
function getCurrentEngine() {
  return ENGINE_MODE;
}

module.exports = {
  generate,
  getCurrentEngine,
  // Expose internals for testing
  _wan2gp: wan2gpEngine
};
