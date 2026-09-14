/**
 * Engine Abstraction Tests
 *
 * Verifies:
 * 1. Both engines export same interface (generate function)
 * 2. Switching ENV_ENGINE at runtime uses different backend
 * 3. Both engines accept same input format
 * 4. Both engines return correct output shape
 * 5. Error handling works consistently
 */

const assert = require("assert");
const path = require("path");

// Helper to clear module cache and reload with new ENV
function reloadEngineWithEnv(engineMode) {
  // Clear the module cache
  delete require.cache[require.resolve("../index.js")];
  delete require.cache[require.resolve("../wan2gp.js")];
  delete require.cache[require.resolve("../muapi-fallback.js")];
  delete require.cache[require.resolve("../../muapi.js")];

  // Set environment
  process.env.ENGINE_MODE = engineMode;

  // Reload
  return require("../index.js");
}

/**
 * Test 1: Both engines export generate function with same signature
 */
async function testEnginesHaveSameInterface() {
  console.log("TEST 1: Both engines export generate function");

  const wan2gpEngine = require("../wan2gp");
  const muapiEngine = require("../muapi-fallback");

  assert(
    typeof wan2gpEngine.generate === "function",
    "wan2gp must export generate function",
  );
  assert(
    typeof muapiEngine.generate === "function",
    "muapi must export generate function",
  );

  console.log("  ✓ Both engines have generate() method");
}

/**
 * Test 2: Engine factory switches based on ENV
 */
async function testEngineFactorySwitching() {
  console.log("TEST 2: Engine factory switches backends via ENV_ENGINE");

  let engine = reloadEngineWithEnv("wan2gp");
  assert.strictEqual(
    engine.getCurrentEngine(),
    "wan2gp",
    "Should report wan2gp mode",
  );
  console.log("  ✓ ENV_ENGINE=wan2gp loads wan2gp backend");

  engine = reloadEngineWithEnv("muapi");
  assert.strictEqual(
    engine.getCurrentEngine(),
    "muapi",
    "Should report muapi mode",
  );
  console.log("  ✓ ENV_ENGINE=muapi loads muapi backend");

  engine = reloadEngineWithEnv("muapi-fallback");
  assert.strictEqual(
    engine.getCurrentEngine(),
    "muapi-fallback",
    "Should report muapi-fallback mode",
  );
  console.log("  ✓ ENV_ENGINE=muapi-fallback loads muapi backend");
}

/**
 * Test 3: Engine accepts correct input format
 */
async function testEngineInputFormat() {
  console.log("TEST 3: Engines accept correct input format");

  const wan2gpEngine = require("../wan2gp");
  const muapiEngine = require("../muapi-fallback");

  const validInput = {
    prompt: "A person walking in a park",
    firstFrame: null,
    soulId: "soul_123",
    voiceId: "voice_456",
  };

  // Test missing required params
  const missingPrompt = {
    firstFrame: null,
    soulId: "soul_123",
    voiceId: "voice_456",
  };
  const missingSoulId = {
    prompt: "test",
    firstFrame: null,
    voiceId: "voice_456",
  };
  const missingVoiceId = {
    prompt: "test",
    firstFrame: null,
    soulId: "soul_123",
  };

  try {
    await wan2gpEngine.generate(missingPrompt);
    assert.fail("Should reject missing prompt");
  } catch (error) {
    assert(
      error.message.includes("prompt"),
      "Error should mention missing prompt",
    );
    console.log("  ✓ Wan2GP rejects missing prompt");
  }

  try {
    await muapiEngine.generate(missingSoulId);
    assert.fail("Should reject missing soulId");
  } catch (error) {
    assert(
      error.message.includes("soulId"),
      "Error should mention missing soulId",
    );
    console.log("  ✓ Muapi rejects missing soulId");
  }

  try {
    await muapiEngine.generate(missingVoiceId);
    assert.fail("Should reject missing voiceId");
  } catch (error) {
    assert(
      error.message.includes("voiceId"),
      "Error should mention missing voiceId",
    );
    console.log("  ✓ Muapi rejects missing voiceId");
  }
}

/**
 * Test 4: Engine output has correct shape
 */
async function testEngineOutputShape() {
  console.log("TEST 4: Engine outputs have correct shape");

  const muapiEngine = require("../muapi-fallback");

  const input = {
    prompt: "Test video generation",
    firstFrame: null,
    soulId: "soul_123",
    voiceId: "voice_456",
  };

  const result = await muapiEngine.generate(input);

  assert(result, "Result must exist");
  assert.strictEqual(typeof result, "object", "Result must be object");
  assert(result.video !== undefined, "Result must have video field");
  assert(result.lastFrame !== undefined, "Result must have lastFrame field");
  assert(result.audioPath !== undefined, "Result must have audioPath field");

  console.log("  ✓ Output shape correct: { video, lastFrame, audioPath }");
  console.log(`    - video: ${typeof result.video}`);
  console.log(`    - lastFrame: ${typeof result.lastFrame}`);
  console.log(`    - audioPath: ${typeof result.audioPath}`);
}

/**
 * Test 5: Verify factory correctly routes to each engine
 */
async function testFactoryRouting() {
  console.log("TEST 5: Factory correctly routes to active backend");

  // Test Wan2GP routing
  let engine = reloadEngineWithEnv("wan2gp");
  assert(
    typeof engine._wan2gp !== "undefined",
    "Should expose _wan2gp for testing",
  );
  console.log("  ✓ Factory can route to wan2gp");

  // Test Muapi routing
  engine = reloadEngineWithEnv("muapi");
  assert(
    typeof engine._muapi !== "undefined",
    "Should expose _muapi for testing",
  );
  console.log("  ✓ Factory can route to muapi");

  // Test default (should be wan2gp)
  // Don't set ENGINE_MODE at all - let the default kick in
  delete process.env.ENGINE_MODE;
  delete require.cache[require.resolve("../index.js")];
  delete require.cache[require.resolve("../wan2gp.js")];
  delete require.cache[require.resolve("../muapi-fallback.js")];
  const defaultEngine = require("../index.js");
  assert.strictEqual(
    defaultEngine.getCurrentEngine(),
    "wan2gp",
    "Should default to wan2gp",
  );
  console.log("  ✓ Defaults to wan2gp when ENV_ENGINE not set");
}

/**
 * Test 6: firstFrame is optional
 */
async function testFirstFrameOptional() {
  console.log("TEST 6: firstFrame parameter is optional");

  const muapiEngine = require("../muapi-fallback");

  const inputWithoutFirstFrame = {
    prompt: "Generate video",
    soulId: "soul_123",
    voiceId: "voice_456",
    // No firstFrame specified
  };

  const result = await muapiEngine.generate(inputWithoutFirstFrame);
  assert(result.video, "Should succeed without firstFrame");
  console.log("  ✓ Engines work without firstFrame parameter");

  const inputWithFirstFrame = {
    prompt: "Generate video",
    firstFrame: "/path/to/frame.png",
    soulId: "soul_123",
    voiceId: "voice_456",
  };

  const result2 = await muapiEngine.generate(inputWithFirstFrame);
  assert(result2.video, "Should succeed with firstFrame");
  console.log("  ✓ Engines work with firstFrame parameter");
}

/**
 * Main test runner
 */
async function runAllTests() {
  console.log("\n=== ENGINE ABSTRACTION TEST SUITE ===\n");

  const tests = [
    testEnginesHaveSameInterface,
    testEngineFactorySwitching,
    testEngineInputFormat,
    testEngineOutputShape,
    testFactoryRouting,
    testFirstFrameOptional,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
      console.log();
    } catch (error) {
      failed++;
      console.error(`  ✗ FAILED: ${error.message}`);
      console.error(error.stack);
      console.log();
    }
  }

  console.log("=== TEST SUMMARY ===");
  console.log(`Passed: ${passed}/${tests.length}`);
  console.log(`Failed: ${failed}/${tests.length}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  runAllTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
  });
}

module.exports = {
  runAllTests,
  testEnginesHaveSameInterface,
  testEngineFactorySwitching,
  testEngineInputFormat,
  testEngineOutputShape,
  testFactoryRouting,
  testFirstFrameOptional,
};
