const mockFetch = jest.fn();
jest.mock("node-fetch", () => mockFetch);

const {
  generatePrompts,
  extractPromptArray,
  validatePrompts,
} = require("../src/lib/claude");

const STORY =
  "A lone courier crosses a flooded city to deliver a message that will end a war. " +
  "Along the way she loses her boat, her map, and nearly her nerve, but never the letter.";

function samplePrompts(n = 8) {
  return Array.from({ length: n }, (_, i) => ({
    character: `Mira, a weathered courier in a grey coat (beat ${i})`,
    scene: `Flooded avenue, segment ${i}, water rising past the storefronts`,
    voiceDirection: i % 2 === 0 ? "tense, hushed" : "resolute, breathless",
  }));
}

function claudeResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ text: body }] }),
  };
}

describe("Claude Orchestration (C4)", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key" };
    delete process.env.QWEN_API_KEY;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  describe("extractPromptArray", () => {
    test("parses a raw JSON array", () => {
      const raw = JSON.stringify(samplePrompts());
      expect(extractPromptArray(raw)).toHaveLength(8);
    });

    test("parses a markdown-fenced array", () => {
      const raw = "```json\n" + JSON.stringify(samplePrompts()) + "\n```";
      expect(extractPromptArray(raw)).toHaveLength(8);
    });

    test("parses an array wrapped in an object key", () => {
      const raw = JSON.stringify({ clips: samplePrompts() });
      expect(extractPromptArray(raw)).toHaveLength(8);
    });

    test("parses an array surrounded by prose", () => {
      const raw = `Here are the clips:\n${JSON.stringify(samplePrompts())}\nHope that helps!`;
      expect(extractPromptArray(raw)).toHaveLength(8);
    });

    test("throws when no JSON array is present", () => {
      expect(() => extractPromptArray("I cannot help with that.")).toThrow(
        /did not contain a JSON array/,
      );
    });
  });

  describe("validatePrompts", () => {
    test("rejects a count other than 8", () => {
      expect(() => validatePrompts(samplePrompts(7))).toThrow(/exactly 8/);
      expect(() => validatePrompts(samplePrompts(9))).toThrow(/exactly 8/);
    });

    test("rejects a prompt missing a required field", () => {
      const prompts = samplePrompts();
      delete prompts[3].voiceDirection;
      expect(() => validatePrompts(prompts)).toThrow(/Prompt 3.*voiceDirection/);
    });

    test("rejects an empty required field", () => {
      const prompts = samplePrompts();
      prompts[0].scene = "";
      expect(() => validatePrompts(prompts)).toThrow(/Prompt 0.*scene/);
    });

    test("builds fullPrompt with all three tags", () => {
      const [first] = validatePrompts(samplePrompts());
      expect(first.fullPrompt).toMatch(/<character>.+<\/character>/);
      expect(first.fullPrompt).toMatch(/<scene>.+<\/scene>/);
      expect(first.fullPrompt).toMatch(
        /<voice_direction>.+<\/voice_direction>/,
      );
    });
  });

  describe("generatePrompts", () => {
    test("returns exactly 8 prompts carrying all 3 tags", async () => {
      mockFetch.mockResolvedValueOnce(
        claudeResponse(JSON.stringify(samplePrompts())),
      );

      const prompts = await generatePrompts(STORY);

      expect(prompts).toHaveLength(8);
      for (const prompt of prompts) {
        expect(typeof prompt.character).toBe("string");
        expect(typeof prompt.scene).toBe("string");
        expect(typeof prompt.voiceDirection).toBe("string");
        expect(prompt.fullPrompt).toContain("<character>");
        expect(prompt.fullPrompt).toContain("<scene>");
        expect(prompt.fullPrompt).toContain("<voice_direction>");
      }
    });

    test("output shape feeds C6 captions directly", async () => {
      mockFetch.mockResolvedValueOnce(
        claudeResponse(JSON.stringify(samplePrompts())),
      );
      const { generateCaptions } = require("../src/builder/captions");

      const prompts = await generatePrompts(STORY);
      await expect(generateCaptions(prompts)).resolves.toContain("-->");
    });

    test("retries on malformed output and succeeds", async () => {
      mockFetch
        .mockResolvedValueOnce(claudeResponse("not json at all"))
        .mockResolvedValueOnce(
          claudeResponse(JSON.stringify(samplePrompts())),
        );

      const prompts = await generatePrompts(STORY);

      expect(prompts).toHaveLength(8);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("retries when the model returns the wrong clip count", async () => {
      mockFetch
        .mockResolvedValueOnce(claudeResponse(JSON.stringify(samplePrompts(5))))
        .mockResolvedValueOnce(
          claudeResponse(JSON.stringify(samplePrompts())),
        );

      await expect(generatePrompts(STORY)).resolves.toHaveLength(8);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("gives up after 3 attempts", async () => {
      mockFetch.mockResolvedValue(claudeResponse("still not json"));

      await expect(generatePrompts(STORY)).rejects.toThrow(
        /after 3 attempts/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test("surfaces API errors after exhausting retries", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 529 });

      await expect(generatePrompts(STORY)).rejects.toThrow(/529/);
    });

    test("falls back to Qwen when no Anthropic key is set", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.QWEN_API_KEY = "qwen-key";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(samplePrompts()) } }],
        }),
      });

      await expect(generatePrompts(STORY)).resolves.toHaveLength(8);
      expect(mockFetch.mock.calls[0][0]).toMatch(/dashscope/);
    });

    test("throws when no API key is configured", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      await expect(generatePrompts(STORY)).rejects.toThrow(/must be set/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("rejects an empty story", async () => {
      await expect(generatePrompts("")).rejects.toThrow(/non-empty string/);
      await expect(generatePrompts(null)).rejects.toThrow(/non-empty string/);
    });
  });
});
