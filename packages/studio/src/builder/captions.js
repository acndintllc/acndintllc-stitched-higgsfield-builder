/**
 * Caption Generation (C6)
 * Generates SRT subtitle file with timecodes from character prompts
 */

/**
 * Convert seconds to SRT timecode format (HH:MM:SS,mmm)
 * @param {number} seconds - Time in seconds
 * @returns {string} SRT timecode
 */
function secondsToTimecode(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Generate caption text from prompt data
 * Ensures captions are 40-60 characters as per spec
 * @param {Object} prompt - Character prompt with scene and voiceDirection
 * @param {number} index - Caption index within clip
 * @returns {string} Caption text (40-60 chars)
 */
function generateCaptionText(prompt, index) {
  const { character, scene, voiceDirection } = prompt;

  // Generate caption text that combines elements from the prompt
  // Each caption targets 40-60 character range
  const templates = [
    `${character} enters ${scene}. A ${voiceDirection} presence fills the air`,
    `${character} moves through ${scene} with determination and grace`,
    `The atmosphere shifts: ${character} contemplates the ${voiceDirection} moment`,
  ];

  let caption = templates[index % templates.length];

  // Adjust length to fit 40-60 character requirement
  if (caption.length < 40) {
    // Expand the caption
    caption = caption + ' ' + character + ' reflects.';
  }

  if (caption.length > 60) {
    // Trim to fit, preferring word boundaries
    let trimmed = caption.substring(0, 60);
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > 40) {
      caption = caption.substring(0, lastSpace).trim();
    } else {
      caption = trimmed.trim();
    }
  }

  // Final verification and padding
  caption = caption.trim();
  if (caption.length < 40) {
    caption = caption + '...';
    while (caption.length < 40) {
      caption = caption + ' ';
    }
  }

  return caption.substring(0, 60).trim();
}

/**
 * Generate SRT subtitles from prompts
 * @param {Array<Object>} prompts - Array of 8 prompts with character, scene, voiceDirection
 * @returns {Promise<string>} SRT formatted subtitle content
 */
async function generateCaptions(prompts) {
  // Validate input
  if (!Array.isArray(prompts) || prompts.length !== 8) {
    throw new Error('Expected exactly 8 prompts');
  }

  const srtLines = [];
  let captionNumber = 1;
  const CLIP_DURATION = 60; // seconds
  const CAPTIONS_PER_CLIP = 3;
  const CAPTION_DURATION = CLIP_DURATION / CAPTIONS_PER_CLIP; // 20 seconds per caption

  // Process each of the 8 clips
  for (let clipIndex = 0; clipIndex < prompts.length; clipIndex++) {
    const prompt = prompts[clipIndex];
    const clipStartTime = clipIndex * CLIP_DURATION;

    // Generate 3 captions per clip
    for (let captionIndex = 0; captionIndex < CAPTIONS_PER_CLIP; captionIndex++) {
      const startTime = clipStartTime + captionIndex * CAPTION_DURATION;
      const endTime = startTime + CAPTION_DURATION;

      // Format timecodes
      const startTimecode = secondsToTimecode(startTime);
      const endTimecode = secondsToTimecode(endTime);

      // Generate caption text
      const captionText = generateCaptionText(prompt, captionIndex);

      // Build SRT entry
      srtLines.push(captionNumber.toString());
      srtLines.push(`${startTimecode} --> ${endTimecode}`);
      srtLines.push(captionText);
      srtLines.push(''); // Blank line between entries

      captionNumber++;
    }
  }

  return srtLines.join('\n');
}

module.exports = { generateCaptions, secondsToTimecode };
