/**
 * Engine Abstraction Layer
 *
 * Factory function that returns the active engine backend based on ENV.
 * Supports: wan2gp (primary), muapi-fallback (fallback)
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
const muapiEngine = require('./muapi-fallback');

// Determine active engine from environment
const ENGINE_MODE = process.env.ENGINE_MODE || 'wan2gp';

/**
 * Get the active engine instance
 * @returns {Object} Engine with generate() method
 */
function getEngine() {
  switch (ENGINE_MODE.toLowerCase()) {
    case 'wan2gp':
      return wan2gpEngine;
    case 'muapi':
    case 'muapi-fallback':
      return muapiEngine;
    default:
      console.warn(`Unknown ENGINE_MODE: ${ENGINE_MODE}, defaulting to wan2gp`);
      return wan2gpEngine;
  }
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
    throw new Error(`Engine not initialized or missing generate method`);
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
  _wan2gp: wan2gpEngine,
  _muapi: muapiEngine
};
