const {
  generateCaptions,
  secondsToTimecode,
} = require("../src/builder/captions");

const CLIP_COUNT = 8;
const CLIP_DURATION = 60;
const TOTAL_RUNTIME = CLIP_COUNT * CLIP_DURATION;

function samplePrompts(n = CLIP_COUNT) {
  return Array.from({ length: n }, (_, i) => ({
    character: "Mira",
    scene: `flooded avenue ${i}`,
    voiceDirection: i % 2 === 0 ? "tense" : "resolute",
  }));
}

function timecodeToSeconds(timecode) {
  const match = timecode.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) throw new Error(`Malformed timecode: ${timecode}`);
  const [, hh, mm, ss, ms] = match;
  return +hh * 3600 + +mm * 60 + +ss + +ms / 1000;
}

/** Strict SRT parser — throws on any structural deviation. */
function parseSrt(srt) {
  const blocks = srt.trim().split(/\n\s*\n/);
  return blocks.map((block, blockIndex) => {
    const lines = block.split("\n");
    if (lines.length < 3) {
      throw new Error(`Block ${blockIndex} has fewer than 3 lines`);
    }

    const index = Number(lines[0]);
    if (!Number.isInteger(index)) {
      throw new Error(`Block ${blockIndex} has a non-integer index`);
    }

    const arrow = lines[1].match(/^(\S+) --> (\S+)$/);
    if (!arrow) {
      throw new Error(`Block ${blockIndex} has a malformed timecode line`);
    }

    return {
      index,
      start: timecodeToSeconds(arrow[1]),
      end: timecodeToSeconds(arrow[2]),
      text: lines.slice(2).join("\n").trim(),
    };
  });
}

describe("Caption Generation (C6)", () => {
  describe("secondsToTimecode", () => {
    test("formats zero", () => {
      expect(secondsToTimecode(0)).toBe("00:00:00,000");
    });

    test("formats minutes and seconds", () => {
      expect(secondsToTimecode(83)).toBe("00:01:23,000");
    });

    test("formats milliseconds", () => {
      expect(secondsToTimecode(1.5)).toBe("00:00:01,500");
    });

    test("formats the full 8-minute runtime", () => {
      expect(secondsToTimecode(TOTAL_RUNTIME)).toBe("00:08:00,000");
    });
  });

  describe("generateCaptions", () => {
    test("rejects anything other than 8 prompts", async () => {
      await expect(generateCaptions(samplePrompts(7))).rejects.toThrow(
        /exactly 8/,
      );
      await expect(generateCaptions([])).rejects.toThrow(/exactly 8/);
      await expect(generateCaptions(null)).rejects.toThrow(/exactly 8/);
    });

    test("output parses as valid SRT", async () => {
      const srt = await generateCaptions(samplePrompts());
      expect(() => parseSrt(srt)).not.toThrow();
      expect(parseSrt(srt).length).toBeGreaterThan(0);
    });

    test("caption indices are sequential from 1", async () => {
      const cues = parseSrt(await generateCaptions(samplePrompts()));
      cues.forEach((cue, i) => expect(cue.index).toBe(i + 1));
    });

    test("timecodes are ordered and never overlap", async () => {
      const cues = parseSrt(await generateCaptions(samplePrompts()));

      for (const cue of cues) {
        expect(cue.end).toBeGreaterThan(cue.start);
      }
      for (let i = 1; i < cues.length; i++) {
        expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
      }
    });

    test("covers 100% of the runtime with no gaps", async () => {
      const cues = parseSrt(await generateCaptions(samplePrompts()));

      expect(cues[0].start).toBe(0);
      expect(cues[cues.length - 1].end).toBe(TOTAL_RUNTIME);
      for (let i = 1; i < cues.length; i++) {
        expect(cues[i].start).toBe(cues[i - 1].end);
      }

      const covered = cues.reduce((sum, c) => sum + (c.end - c.start), 0);
      expect(covered).toBe(TOTAL_RUNTIME);
    });

    test("every caption is readable (40-60 characters)", async () => {
      const cues = parseSrt(await generateCaptions(samplePrompts()));

      for (const cue of cues) {
        expect(cue.text.length).toBeGreaterThanOrEqual(40);
        expect(cue.text.length).toBeLessThanOrEqual(60);
      }
    });

    test("no caption is empty", async () => {
      const cues = parseSrt(await generateCaptions(samplePrompts()));
      for (const cue of cues) {
        expect(cue.text.trim().length).toBeGreaterThan(0);
      }
    });

    test("captions reflect each clip's prompt", async () => {
      const prompts = samplePrompts();
      prompts[0].character = "Zephyr";
      const cues = parseSrt(await generateCaptions(prompts));

      const firstClipText = cues
        .slice(0, 3)
        .map((c) => c.text)
        .join(" ");
      expect(firstClipText).toContain("Zephyr");
    });
  });
});
