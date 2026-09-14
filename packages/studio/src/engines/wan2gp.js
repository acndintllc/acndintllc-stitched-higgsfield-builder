/**
 * Wan2GP Engine
 *
 * Generates videos using Wan2GP local server (http://127.0.0.1:7860)
 * Queue-driven submission with polling for completion.
 */

const http = require('http');
const path = require('path');

// Configuration from environment or defaults
const WAN2GP_HOST = process.env.WAN2GP_HOST || '127.0.0.1';
const WAN2GP_PORT = process.env.WAN2GP_PORT || 7860;
const WAN2GP_API_BASE = `http://${WAN2GP_HOST}:${WAN2GP_PORT}`;
const POLL_INTERVAL_MS = parseInt(process.env.WAN2GP_POLL_INTERVAL || '2000', 10);
const MAX_POLL_ATTEMPTS = parseInt(process.env.WAN2GP_MAX_POLLS || '300', 10); // 10 min @ 2s interval

/**
 * Make HTTP request to Wan2GP server
 */
function makeRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WAN2GP_API_BASE}${endpoint}`);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`Wan2GP error ${res.statusCode}: ${parsed.error || data}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Wan2GP error ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Submit a generation job to Wan2GP
 */
async function submitJob({ prompt, firstFrame, soulId, voiceId }) {
  const payload = {
    prompt,
    soul_id: soulId,
    voice_id: voiceId,
    ...(firstFrame && { first_frame: firstFrame })
  };

  const response = await makeRequest('POST', '/api/generate', payload);

  if (!response.job_id) {
    throw new Error('Wan2GP did not return job_id');
  }

  return response.job_id;
}

/**
 * Poll for job completion
 */
async function pollJob(jobId) {
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;

    try {
      const response = await makeRequest('GET', `/api/generate/${jobId}`);

      if (response.status === 'completed') {
        return response;
      }

      if (response.status === 'failed') {
        throw new Error(`Job ${jobId} failed: ${response.error || 'unknown error'}`);
      }

      // Still processing, wait and retry
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      // Retry on network errors, but fail on job errors
      if (error.message.includes('failed')) {
        throw error;
      }
      console.warn(`Poll attempt ${attempts} failed, retrying: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error(`Job ${jobId} did not complete within ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`);
}

/**
 * Extract last frame from response
 * Wan2GP returns a frames array; lastFrame is the final one
 */
function extractLastFrame(jobResult) {
  if (jobResult.frames && Array.isArray(jobResult.frames) && jobResult.frames.length > 0) {
    return jobResult.frames[jobResult.frames.length - 1];
  }

  if (jobResult.last_frame) {
    return jobResult.last_frame;
  }

  throw new Error('No last_frame or frames array in job result');
}

/**
 * Main generate function
 */
async function generate({ prompt, firstFrame = null, soulId, voiceId }) {
  if (!prompt || !soulId || !voiceId) {
    throw new Error('Missing required params: prompt, soulId, voiceId');
  }

  try {
    // Submit generation job
    const jobId = await submitJob({ prompt, firstFrame, soulId, voiceId });
    console.log(`[Wan2GP] Submitted job: ${jobId}`);

    // Poll until complete
    const result = await pollJob(jobId);
    console.log(`[Wan2GP] Job ${jobId} completed`);

    // Extract outputs
    const lastFrame = extractLastFrame(result);
    const audioPath = result.audio_path || result.audioPath;

    if (!result.video && !result.video_path && !result.videoPath) {
      throw new Error('Job result missing video output');
    }

    return {
      video: result.video || result.video_path || result.videoPath,
      lastFrame,
      audioPath
    };
  } catch (error) {
    console.error('[Wan2GP] Generation failed:', error.message);
    throw error;
  }
}

module.exports = {
  generate
};
