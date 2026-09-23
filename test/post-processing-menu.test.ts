import assert from "node:assert/strict";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG_MODELS } from "../src/catalog.js";
import { CatalogModelPicker } from "../src/model-picker.js";
import { showSettingsMenu } from "../src/settings-menu.js";
import {
  DEFAULT_POST_PROCESSING_PROMPT,
  readSettings,
  settingsForModel,
  writeSettings,
  type PostProcessingSettings,
} from "../src/settings.js";
import { SingleSelectPicker } from "../src/ui-components.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";
import { isolatedSettings, scriptedSettingsContext } from "./post-processing-helper.js";

type Step = Parameters<typeof scriptedSettingsContext>[0][number];

initTheme("dark");

const model = { provider: "provider-a", id: "correction-model" };
const otherModel = { provider: "provider-b", id: "other-model" };

function settings(postProcessing?: PostProcessingSettings) {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/asr-model", {
    preferredLanguages: ["en"], postProcessing,
  });
}

function selectRow(index: number, title: RegExp, check?: () => void | Promise<void>): Step {
  return {
    type: "custom",
    run: async (pane) => {
      await check?.();
      assert.ok(pane instanceof SingleSelectPicker);
      assert.match(pane.render(100).join("\n"), title);
      for (let i = 0; i < index; i += 1) pane.handleInput("\x1b[B");
      pane.handleInput("\r");
    },
  };
}

const enterPostProcessing = () => selectRow(3, /Pi Voice settings[\s\S]*Post-processing/);
const action = (index: number, check?: () => void | Promise<void>) =>
  selectRow(index, /Post-processing[\s\S]*sent to the chosen provider[\s\S]*may cost money/, check);
const closePane: Step = { type: "custom", run: (pane) => pane.handleInput?.("\x1b") };
const selectModel = (provider: string): Step => ({
  type: "custom",
  run: (pane) => {
    assert.ok(pane instanceof SingleSelectPicker);
    const text = pane.render(100).join(" ").replace(/\s+/g, " ");
    assert.match(text, /Choose post-processing LLM/);
    assert.match(text, /does not change the main session model/);
    assert.match(text, /provider-a\/correction-model/);
    assert.match(text, /provider-b\/other-model/);
    pane.handleInput(provider);
    pane.handleInput("\r");
  },
});
const confirmProvider = (confirmed: boolean, provider = "provider-a"): Step => ({
  type: "confirm",
  run: (_title, message) => {
    assert.match(message, new RegExp(`sent to ${provider}/`));
    assert.match(message, /may cost money/);
    assert.match(message, /main session model is unchanged/);
    return confirmed;
  },
});

async function openMenu(
  configured: ReturnType<typeof settings>,
  steps: Step[],
  models?: Parameters<typeof scriptedSettingsContext>[1],
) {
  const script = scriptedSettingsContext([enterPostProcessing(), ...steps, closePane, closePane], models);
  assert.equal(await showSettingsMenu({} as ExtensionAPI, script.ctx, configured, configured.shortcut), false);
  script.assertFinished();
  return script;
}

test("choosing a specific correction model saves immediately without enabling or accessing the session model", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const script = await openMenu(configured, [
    action(1),
    selectModel("provider-b"),
    action(2, async () => {
      assert.deepEqual(configured.postProcessing.model, otherModel);
      assert.equal(configured.postProcessing.enabled, false);
      assert.deepEqual((await readSettings()).settings, configured);
    }),
    { type: "editor", run: (_title, prefill) => {
      assert.equal(prefill, DEFAULT_POST_PROCESSING_PROMPT);
      return undefined;
    } },
  ]);
  assert.equal(script.notifications.length, 1);
  assert.match(script.notifications[0]!.message, /main session model unchanged/);
});

test("enable chooses and confirms an LLM atomically; disable retains model and prompt", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const original = structuredClone(configured);
  await openMenu(configured, [
    action(0),
    selectModel("provider-a"),
    { type: "confirm", run: (_title, message) => {
      assert.deepEqual(configured, original);
      assert.match(message, /sent to provider-a\/correction-model/);
      assert.match(message, /may cost money/);
      return true;
    } },
    action(0, async () => {
      assert.equal(configured.postProcessing.enabled, true);
      assert.deepEqual(configured.postProcessing.model, model);
      assert.deepEqual((await readSettings()).settings, configured);
    }),
  ]);
  assert.deepEqual(configured.postProcessing, { ...original.postProcessing, model, enabled: false });
  assert.deepEqual((await readSettings()).settings, configured);
});

test("cancelling an unselected model picker or enable confirmation leaves no partial configuration", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const original = structuredClone(configured);
  const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
  const script = await openMenu(configured, [
    action(1), closePane,
    action(0), closePane,
    action(0), selectModel("provider-a"), confirmProvider(false),
  ]);
  assert.deepEqual(configured, original);
  assert.deepEqual(script.notifications, []);
  assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
});

test("editing preserves the full prompt and reset restores the default immediately", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: false, model, prompt: "Original prompt\nLine two" });
  const edited = "  Correct only ASR mistakes.\nKeep names and original language.\n  ";
  await writeSettings(configured);
  await openMenu(configured, [
    action(2),
    { type: "editor", run: (title, prefill) => {
      assert.match(title, /correction prompt/);
      assert.equal(prefill, configured.postProcessing.prompt);
      return edited;
    } },
    action(3, async () => {
      assert.equal(configured.postProcessing.prompt, edited);
      assert.deepEqual((await readSettings()).settings, configured);
    }),
    { type: "confirm", run: (title) => {
      assert.match(title, /Reset correction prompt/);
      return true;
    } },
  ]);
  assert.deepEqual(configured.postProcessing, { enabled: false, model, prompt: DEFAULT_POST_PROCESSING_PROMPT });
  assert.deepEqual((await readSettings()).settings, configured);
});

test("cancelled prompt editing and reset, unchanged and empty edits do not save", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings({ enabled: true, model, prompt: "Full custom\nprompt" });
  await writeSettings(configured);
  const original = structuredClone(configured);
  const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
  const script = await openMenu(configured, [
    action(2), { type: "editor", run: () => undefined },
    action(2), { type: "editor", run: (_title, prefill) => prefill },
    action(2), { type: "editor", run: () => " \n " },
    action(3), { type: "confirm", run: () => false },
  ]);
  assert.deepEqual(configured, original);
  assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
  assert.equal(script.notifications.length, 1);
  assert.match(script.notifications[0]!.message, /cannot be empty/);
});

test("enable reuses the chosen LLM and switching an enabled provider asks for confirmation", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: false, model, prompt: DEFAULT_POST_PROCESSING_PROMPT });
  await writeSettings(configured);
  await openMenu(configured, [
    action(0), confirmProvider(true),
    action(1), selectModel("provider-b"), confirmProvider(false, "provider-b"),
    action(1, () => { assert.deepEqual(configured.postProcessing.model, model); }),
    selectModel("provider-b"), confirmProvider(true, "provider-b"),
  ]);
  assert.equal(configured.postProcessing.enabled, true);
  assert.deepEqual(configured.postProcessing.model, otherModel);
  assert.deepEqual((await readSettings()).settings, configured);
});

test("no available LLMs cannot enable correction or fall back to the session model", async (t) => {
  isolatedSettings(t);
  for (const chosen of [undefined, model]) {
    const configured = settings({ enabled: false, model: chosen, prompt: DEFAULT_POST_PROCESSING_PROMPT });
    await writeSettings(configured);
    const original = structuredClone(configured);
    const script = await openMenu(configured, [action(0)], []);
    assert.equal(script.notifications.length, 1);
    assert.match(script.notifications[0]!.message, /No LLMs available|chosen LLM is unavailable/);
    assert.deepEqual(configured, original);
    assert.deepEqual((await readSettings()).settings, configured);
  }
});

test("failed saves leave live post-processing settings untouched and report the error", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings();
  const original = structuredClone(configured);
  await writeSettings(configured);
  const path = join(directory, "pi-voice.json");
  await unlink(path);
  await mkdir(path); // A directory at the destination makes the atomic rename fail.
  const script = await openMenu(configured, [action(1), selectModel("provider-a")]);
  assert.deepEqual(configured, original);
  assert.equal(script.notifications.length, 1);
  assert.equal(script.notifications[0]!.type, "error");
  assert.match(script.notifications[0]!.message, /Could not save settings/);
  assert.deepEqual(await readdir(directory), ["pi-voice.json"]);
});

test("the settings model picker forwards post-processing through ASR switches", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: true, model, prompt: "Keep my correction prompt" });
  await writeSettings(configured);
  const cache = isolatedModelCache(t);
  const target = CATALOG_MODELS.find((candidate) => candidate.id !== configured.model.id)!;
  cacheCatalogModel(cache, target);
  const original = structuredClone(configured.postProcessing);
  const script = scriptedSettingsContext([
    selectRow(1, /Pi Voice settings/),
    {
      type: "custom",
      run: (pane) => {
        assert.ok(pane instanceof CatalogModelPicker);
        pane.handleInput(target.id);
        pane.handleInput("\r");
        pane.handleInput("\x1b"); // Clear search.
        pane.handleInput("\x1b"); // Exit after the pending commit.
      },
    },
    closePane,
  ]);
  assert.equal(await showSettingsMenu({} as ExtensionAPI, script.ctx, configured, configured.shortcut), false);
  script.assertFinished();
  assert.equal(configured.model.id, target.id);
  assert.deepEqual(configured.postProcessing, original);
  assert.deepEqual((await readSettings()).settings, configured);
});
