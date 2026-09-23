import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  isPostProcessingReasoningLevel,
  POST_PROCESSING_REASONING_LEVELS,
  supportedPostProcessingReasoningLevels,
} from "../src/post-processing-reasoning.js";
import { validatePostProcessingSettings } from "../src/post-processing-settings.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";
import { isolatedSettings } from "./post-processing-helper.js";

const previous = {
  enabled: true,
  model: { provider: "provider-a", id: "correction-model" },
  prompt: "My existing custom prompt\n  Keep names unchanged.  ",
};

function asrSettings() {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/asr-model");
}

test("only explicit non-off reasoning levels are accepted", () => {
  for (const level of POST_PROCESSING_REASONING_LEVELS) {
    assert.equal(isPostProcessingReasoningLevel(level), true);
    assert.deepEqual(validatePostProcessingSettings({ ...previous, reasoning: level }), {
      ...previous, reasoning: level,
    });
  }
  for (const value of [undefined, null, "", "off", "default", "auto", "LOW", true, 1, {}, []]) {
    assert.equal(isPostProcessingReasoningLevel(value), false);
    assert.deepEqual(validatePostProcessingSettings({ ...previous, reasoning: value }), {
      ...previous, enabled: false,
    });
  }
});

test("supported levels respect model reasoning metadata without implicit off or extended support", () => {
  assert.deepEqual(supportedPostProcessingReasoningLevels({ reasoning: false }), []);
  assert.deepEqual(supportedPostProcessingReasoningLevels({ reasoning: true }), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(supportedPostProcessingReasoningLevels({
    reasoning: true, thinkingLevelMap: { minimal: null, low: "low", medium: null, xhigh: "high", max: null },
  }), ["low", "high", "xhigh"]);
  assert.deepEqual(supportedPostProcessingReasoningLevels({
    reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, max: "max" },
  }), ["max"]);
});

test("legacy enabled settings without reasoning are disabled with a warning, preserving model and prompt", async (t) => {
  const directory = isolatedSettings(t);
  const original = { ...asrSettings(), postProcessing: previous };
  const path = join(directory, "pi-voice.json");
  await writeFile(path, JSON.stringify(original));
  const result = await readSettings();
  assert.deepEqual(result.settings, { ...original, postProcessing: { ...previous, enabled: false } });
  assert.match(result.warning!, /Post-processing is disabled.*required reasoning level.*enable it again/);
  // Merely reading does not overwrite the user's existing configuration.
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
});

test("invalid required reasoning warns and disables correction without disrupting local ASR settings", async (t) => {
  const directory = isolatedSettings(t);
  for (const reasoning of ["off", "default", "invalid", null, 4]) {
    const original = { ...asrSettings(), postProcessing: { ...previous, reasoning } };
    await writeFile(join(directory, "pi-voice.json"), JSON.stringify(original));
    const result = await readSettings();
    assert.deepEqual(result.settings, { ...original, postProcessing: { ...previous, enabled: false } });
    assert.match(result.warning!, /required reasoning level/);
  }
});

test("old disabled settings remain unconfigured without a warning or implicit default", async (t) => {
  isolatedSettings(t);
  const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/asr-model", {
    postProcessing: { ...previous, enabled: false },
  });
  await writeSettings(settings);
  const result = await readSettings();
  assert.deepEqual(result.settings?.postProcessing, { ...previous, enabled: false });
  assert.equal(result.warning, undefined);
});

test("every reasoning level persists when enabled or disabled and across local ASR model settings", async (t) => {
  isolatedSettings(t);
  for (const reasoning of POST_PROCESSING_REASONING_LEVELS) {
    for (const enabled of [false, true]) {
      const postProcessing = { ...previous, enabled, reasoning };
      const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/asr-model", { postProcessing });
      await writeSettings(settings);
      const result = await readSettings();
      assert.deepEqual(result.settings?.postProcessing, postProcessing);
      assert.equal(result.warning, undefined);
      const replacement = settingsForModel(settings.model.id, "/tmp/replaced-asr-model", settings);
      assert.deepEqual(replacement.postProcessing, postProcessing);
    }
  }
});

test("legacy filename migration keeps the required-reasoning warning and preserves the chosen model", async (t) => {
  const directory = isolatedSettings(t);
  await writeFile(join(directory, "pi-transcribe.json"), JSON.stringify({ ...asrSettings(), postProcessing: previous }));
  const result = await readSettings();
  assert.deepEqual(result.settings?.postProcessing, { ...previous, enabled: false });
  assert.match(result.warning!, /required reasoning level/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "pi-voice.json"), "utf8")), result.settings);
  await assert.rejects(readFile(join(directory, "pi-transcribe.json")), { code: "ENOENT" });
});
