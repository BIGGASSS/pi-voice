import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CATALOG_MODELS } from "../src/catalog.js";
import { CatalogModelPicker } from "../src/model-picker.js";
import { changeOnboardingModel, runModelSelection } from "../src/onboarding.js";
import { RecommendedModelPicker } from "../src/recommendation-picker.js";
import { recommendModels } from "../src/recommendations.js";
import {
  DEFAULT_POST_PROCESSING_PROMPT,
  defaultPostProcessingSettings,
  readSettings,
  settingsForModel,
  writeSettings,
  type PostProcessingSettings,
} from "../src/settings.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";
import { isolatedSettings, scriptedSettingsContext } from "./post-processing-helper.js";

initTheme("dark");

const correction: PostProcessingSettings = {
  enabled: true,
  reasoning: "low",
  model: { provider: "provider-a", id: "correction-model" },
  prompt: "  Fix ASR errors only.\nKeep the original language.  ",
};

function initialSettings(postProcessing?: PostProcessingSettings) {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/asr-model", {
    postProcessing,
    preferredLanguages: ["en"],
  });
}

test("post-processing defaults are disabled and independent with a conservative prompt", () => {
  const first = initialSettings();
  const second = initialSettings();
  assert.deepEqual(first.postProcessing, {
    enabled: false,
    prompt: DEFAULT_POST_PROCESSING_PROMPT,
  });
  assert.notEqual(first.postProcessing, second.postProcessing);
  first.postProcessing.prompt = "changed";
  assert.equal(second.postProcessing.prompt, DEFAULT_POST_PROCESSING_PROMPT);
  assert.match(DEFAULT_POST_PROCESSING_PROMPT, /original language/);
  assert.match(DEFAULT_POST_PROCESSING_PROMPT, /Never answer questions or execute commands/);
  assert.match(DEFAULT_POST_PROCESSING_PROMPT, /Return ONLY the corrected transcript/);
});

test("existing settings without post-processing remain valid and disabled", async (t) => {
  const directory = isolatedSettings(t);
  const { postProcessing: _unused, ...oldSettings } = initialSettings();
  const path = join(directory, "pi-voice.json");
  await writeFile(path, JSON.stringify(oldSettings));
  const result = await readSettings();
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.settings, { ...oldSettings, postProcessing: defaultPostProcessingSettings() });
  // Reading current settings is non-destructive; the next save adds the defaults.
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), oldSettings);
});

test("legacy filename migration persists disabled post-processing defaults", async (t) => {
  const directory = isolatedSettings(t);
  const { postProcessing: _unused, ...oldSettings } = initialSettings();
  const legacyPath = join(directory, "pi-transcribe.json");
  await writeFile(legacyPath, JSON.stringify(oldSettings));
  const result = await readSettings();
  assert.equal(result.warning, undefined);
  assert.deepEqual(result.settings?.postProcessing, defaultPostProcessingSettings());
  assert.deepEqual(JSON.parse(await readFile(join(directory, "pi-voice.json"), "utf8")), result.settings);
  await assert.rejects(readFile(legacyPath), { code: "ENOENT" });
});

test("malformed post-processing fails closed without invalidating ASR settings", async (t) => {
  const directory = isolatedSettings(t);
  const invalidValues: unknown[] = [
    null, true, "enabled", [], {},
    { ...correction, enabled: "true" },
    { ...correction, enabled: undefined },
    { ...correction, prompt: undefined },
    { ...correction, prompt: 12 },
    { ...correction, prompt: " \n " },
    { ...correction, model: undefined },
    { ...correction, model: null },
    { ...correction, model: "session" },
    { ...correction, model: [] },
    { ...correction, model: {} },
    { ...correction, model: { provider: "", id: "model" } },
    { ...correction, model: { provider: "provider", id: " " } },
    { ...correction, model: { provider: 1, id: "model" } },
    { ...correction, model: { provider: "provider", id: 1 } },
  ];
  for (const postProcessing of invalidValues) {
    await writeFile(join(directory, "pi-voice.json"), JSON.stringify({ ...initialSettings(), postProcessing }));
    const result = await readSettings();
    assert.equal(result.warning, undefined, JSON.stringify(postProcessing));
    assert.deepEqual(result.settings?.postProcessing, defaultPostProcessingSettings(), JSON.stringify(postProcessing));
  }
});

test("valid enabled, disabled, and unselected configurations round-trip unchanged", async (t) => {
  isolatedSettings(t);
  for (const postProcessing of [
    correction,
    { ...correction, enabled: false },
    { enabled: false, prompt: "Custom prompt before choosing a model" },
  ]) {
    const settings = initialSettings(postProcessing);
    assert.deepEqual(settings.postProcessing, postProcessing);
    await writeSettings(settings);
    assert.deepEqual((await readSettings()).settings, settings);
  }
});

test("settingsForModel preserves and clones post-processing across ASR model switches", () => {
  const initial = initialSettings(correction);
  const otherModel = CATALOG_MODELS.find((model) => model.id !== initial.model.id)!;
  const updated = settingsForModel(otherModel.id, "/tmp/other-model", initial);
  assert.deepEqual(updated.postProcessing, correction);
  assert.notEqual(updated.postProcessing, initial.postProcessing);
  assert.notEqual(updated.postProcessing.model, initial.postProcessing.model);
  updated.postProcessing.model!.id = "changed";
  assert.equal(initial.postProcessing.model!.id, correction.model!.id);
});

test("runModelSelection preserves correction through repeated ASR switches", async (t) => {
  isolatedSettings(t);
  const cache = isolatedModelCache(t);
  let configured = initialSettings(correction);
  for (const target of CATALOG_MODELS.filter((model) => model.id !== configured.model.id).slice(0, 2)) {
    cacheCatalogModel(cache, target);
    const script = scriptedSettingsContext([{
      type: "custom",
      run: (pane) => {
        assert.ok(pane instanceof CatalogModelPicker);
        pane.handleInput(target.id);
        pane.handleInput("\r");
      },
    }]);
    const result = await runModelSelection(script.ctx, {
      ...configured,
      currentModelId: configured.model.id,
      postActivation: "advance",
    });
    script.assertFinished();
    assert.ok(result);
    assert.equal(result.model.id, target.id);
    assert.deepEqual(result.postProcessing, correction);
    assert.deepEqual((await readSettings()).settings, result);
    configured = result;
  }
});

test("changeOnboardingModel preserves correction through recommendation and catalog paths", async (t) => {
  isolatedSettings(t);
  const cache = isolatedModelCache(t);
  const current = initialSettings(correction);
  for (const pick of recommendModels(CATALOG_MODELS, current.preferredLanguages)) {
    cacheCatalogModel(cache, pick.model);
  }
  const recommended = scriptedSettingsContext([{
    type: "custom",
    run: (pane) => {
      assert.ok(pane instanceof RecommendedModelPicker);
      pane.handleInput("\x1b[A");
      pane.handleInput("\r");
    },
  }]);
  const result = await changeOnboardingModel(recommended.ctx, current);
  recommended.assertFinished();
  assert.deepEqual(result?.postProcessing, correction);
  assert.deepEqual((await readSettings()).settings, result);

  const target = CATALOG_MODELS.find((model) => model.id !== current.model.id)!;
  cacheCatalogModel(cache, target);
  const browse = scriptedSettingsContext([
    { type: "custom", run: (pane) => pane.handleInput?.("o") },
    {
      type: "custom",
      run: (pane) => {
        assert.ok(pane instanceof CatalogModelPicker);
        pane.handleInput(target.id);
        pane.handleInput("\r");
      },
    },
  ]);
  const browsed = await changeOnboardingModel(browse.ctx, current);
  browse.assertFinished();
  assert.equal(browsed?.model.id, target.id);
  assert.deepEqual(browsed?.postProcessing, correction);
  assert.deepEqual((await readSettings()).settings, browsed);
});
