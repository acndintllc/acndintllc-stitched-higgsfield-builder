const fetch = require("node-fetch");

const CLIP_COUNT = 8;
const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are a YouTube video director. Break the user's story into exactly ${CLIP_COUNT} sequential clips of roughly 60 seconds each.

Return ONLY a JSON array of exactly ${CLIP_COUNT} objects. Each object must have:
- "character": the character's appearance and state in this clip
- "scene": the setting and action of this clip
- "voiceDirection": the emotional tone for narration of this clip

Rules:
- The character description must stay consistent across all ${CLIP_COUNT} clips.
- Each clip's scene must continue directly from the previous clip's scene.
- Return raw JSON only. No prose, no markdown fences.`;

/**
 * Pull a JSON array out of a model response, which may arrive raw, fenced,
 * or wrapped in a key such as {"clips": [...]}.
 */
function extractPromptArray(text) {
  const candidates = [];
  const trimmed = String(text).trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  const bracketed = trimmed.match(/\[[\s\S]*\]/);
  if (bracketed) candidates.push(bracketed[0]);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const nested = Object.values(parsed).find(Array.isArray);
      if (nested) return nested;
    }
  }

  throw new Error("Response did not contain a JSON array");
}

function validatePrompts(prompts) {
  if (!Array.isArray(prompts)) {
    throw new Error("Expected a JSON array of prompts");
  }
  if (prompts.length !== CLIP_COUNT) {
    throw new Error(
      `Expected exactly ${CLIP_COUNT} prompts, received ${prompts.length}`,
    );
  }

  return prompts.map((prompt, i) => {
    for (const field of ["character", "scene", "voiceDirection"]) {
      if (typeof prompt?.[field] !== "string" || prompt[field].length === 0) {
        throw new Error(`Prompt ${i} is missing a non-empty "${field}"`);
      }
    }
    return {
      character: prompt.character,
      scene: prompt.scene,
      voiceDirection: prompt.voiceDirection,
      fullPrompt:
        `<character>${prompt.character}</character>` +
        `<scene>${prompt.scene}</scene>` +
        `<voice_direction>${prompt.voiceDirection}</voice_direction>`,
    };
  });
}

async function callClaude(story, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: story }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API returned ${response.status}`);
  }

  const data = await response.json();
  return data?.content?.[0]?.text ?? "";
}

async function callQwen(story, apiKey) {
  const response = await fetch(
    process.env.QWEN_API_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.QWEN_MODEL || "qwen-max",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: story },
        ],
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Qwen API returned ${response.status}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turn a story into exactly 8 clip prompts.
 *
 * @param {string} story - the source story (100+ characters)
 * @returns {Promise<Array<{character, scene, voiceDirection, fullPrompt}>>}
 */
async function generatePrompts(story) {
  if (typeof story !== "string" || story.trim().length === 0) {
    throw new Error("story must be a non-empty string");
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const qwenKey = process.env.QWEN_API_KEY;
  if (!anthropicKey && !qwenKey) {
    throw new Error("ANTHROPIC_API_KEY or QWEN_API_KEY must be set");
  }

  const call = anthropicKey
    ? (s) => callClaude(s, anthropicKey)
    : (s) => callQwen(s, qwenKey);

  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const text = await call(story);
      return validatePrompts(extractPromptArray(text));
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  throw new Error(
    `Failed to generate ${CLIP_COUNT} prompts after ${MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

module.exports = { generatePrompts, extractPromptArray, validatePrompts };
