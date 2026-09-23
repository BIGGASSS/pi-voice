import assert from "node:assert/strict";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CATALOG_MODELS } from "../src/catalog.js";
import { CatalogModelPicker } from "../src/model-picker.js";
import { postProcessingSummary } from "../src/post-processing-menu.js";
import type { PostProcessingReasoningLevel } from "../src/post-processing-reasoning.js";
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
type Models = NonNullable<Parameters<typeof scriptedSettingsContext>[1]>;
type Action = "toggle" | "model" | "reasoning" | "prompt" | "reset-prompt";

initTheme("dark");

const model = { provider: "provider-a", id: "correction-model" };
const otherModel = { provider: "provider-b", id: "other-model" };
const baseLevels: PostProcessingReasoningLevel[] = ["minimal", "low", "medium", "high"];
const incompatibleModels: Models = [
  { ...model, name: "Correction LLM", reasoning: true },
  {
    ...otherModel, name: "Other LLM", reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null },
  },
];

// Neither reading nor mutating the session model/thinking level is allowed.
const sessionIndependentApi = new Proxy({} as ExtensionAPI, {
  get: (_target, property) => assert.fail(`Correction configuration accessed session API: ${String(property)}`),
});

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
const action = (name: Action, check?: () => void | Promise<void>) =>
  selectRow(
    ["toggle", "model", "reasoning", "prompt", "reset-prompt"].indexOf(name),
    /Post-processing[\s\S]*sent to the chosen provider[\s\S]*may cost money/,
    check,
  );
const closePane: Step = { type: "custom", run: (pane) => pane.handleInput?.("\x1b") };
const selectModel = (
  provider: string,
  expected = ["provider-a/correction-model", "provider-b/other-model"],
): Step => ({
  type: "custom",
  run: (pane) => {
    assert.ok(pane instanceof SingleSelectPicker);
    const text = pane.render(100).join(" ").replace(/\s+/g, " ");
    assert.match(text, /Choose post-processing LLM/);
    assert.match(text, /does not change the main session model or thinking level/);
    for (const label of expected) assert.ok(text.includes(label), `Missing model: ${label}`);
    assert.doesNotMatch(text, /non-reasoning|all-levels-disabled/);
    pane.handleInput(provider);
    pane.handleInput("\r");
  },
});
const selectReasoning = (
  selected: PostProcessingReasoningLevel,
  options: {
    levels?: PostProcessingReasoningLevel[];
    current?: PostProcessingReasoningLevel;
    check?: () => void | Promise<void>;
  } = {},
): Step => ({
  type: "custom",
  run: async (pane) => {
    await options.check?.();
    assert.ok(pane instanceof SingleSelectPicker);
    const text = pane.render(100).join("\n");
    assert.match(text, /Choose post-processing reasoning level/);
    assert.match(text.replace(/\s+/g, " "), /explicit level is required, independent of the main session thinking level/);
    assert.match(text, /30-second timeout/);
    const rows = text.split("\n").map((line) => line.replace(/^[\s→✓]+/, "").trim())
      .filter((line) => /^(off|default|minimal|low|medium|high|xhigh|max)$/.test(line));
    const levels = options.levels ?? baseLevels;
    assert.deepEqual(rows, levels); // Includes no off/default or unsupported levels.
    if (options.current) assert.match(text, new RegExp(`✓\\s+${options.current}\\b`));
    else assert.doesNotMatch(text, /✓/); // No implicit selection, including for one supported level.
    const start = options.current ? levels.indexOf(options.current) : 0;
    const index = levels.indexOf(selected);
    assert.ok(index >= 0);
    const moves = (index - start + levels.length) % levels.length;
    for (let i = 0; i < moves; i += 1) pane.handleInput("\x1b[B");
    pane.handleInput("\r");
  },
});
const confirmProvider = (
  confirmed: boolean,
  provider = "provider-a",
  reasoning: PostProcessingReasoningLevel = "low",
): Step => ({
  type: "confirm",
  run: (_title, message) => {
    assert.match(message, new RegExp(`sent to ${provider}/`));
    assert.match(message, new RegExp(`with ${reasoning} reasoning`));
    assert.match(message, /may cost money/);
    assert.match(message, /main session model and thinking level are unchanged/);
    return confirmed;
  },
});

async function openMenu(
  configured: ReturnType<typeof settings>,
  steps: Step[],
  models?: Models,
) {
  const script = scriptedSettingsContext([enterPostProcessing(), ...steps, closePane, closePane], models);
  assert.equal(await showSettingsMenu(sessionIndependentApi, script.ctx, configured, configured.shortcut), false);
  script.assertFinished();
  return script;
}

test("post-processing summaries show required or explicitly selected reasoning", () => {
  assert.equal(postProcessingSummary(settings().postProcessing), "Off · Reasoning: required (not selected)");
  assert.equal(postProcessingSummary({ enabled: false, model, prompt: "Prompt" }),
    "Off · provider-a/correction-model · Reasoning: required (not selected)");
  assert.equal(postProcessingSummary({ enabled: true, model, reasoning: "max", prompt: "Prompt" }),
    "On · provider-a/correction-model · Reasoning: max");
});

test("reasoning row follows Model and requires choosing a model first without saving", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
  const script = await openMenu(configured, [{
    type: "custom",
    run: (pane) => {
      assert.ok(pane instanceof SingleSelectPicker);
      const text = pane.render(100).join("\n");
      assert.match(text, /Model: not selected[\s\S]*Reasoning level: required \(not selected\)[\s\S]*Edit correction prompt/);
      pane.handleInput("\x1b[B");
      pane.handleInput("\x1b[B");
      pane.handleInput("\r");
    },
  }]);
  assert.equal(script.notifications.length, 1);
  assert.match(script.notifications[0]!.message, /Choose a post-processing model before/);
  assert.equal(script.notifications[0]!.type, "warning");
  assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
});

test("choosing a correction model saves immediately without enabling or inferring a reasoning level", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const script = await openMenu(configured, [
    action("model"), selectModel("provider-b"),
    action("prompt", async () => {
      assert.deepEqual(configured.postProcessing.model, otherModel);
      assert.equal(configured.postProcessing.enabled, false);
      assert.equal(configured.postProcessing.reasoning, undefined);
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

test("enable chooses model and required reasoning before confirmation, then saves atomically; disable retains both", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const original = structuredClone(configured);
  await openMenu(configured, [
    action("toggle"), selectModel("provider-a"),
    selectReasoning("low", { check: () => { assert.deepEqual(configured, original); } }),
    { type: "confirm", run: (_title, message) => {
      assert.deepEqual(configured, original);
      assert.match(message, /sent to provider-a\/correction-model/);
      assert.match(message, /with low reasoning/);
      assert.match(message, /may cost money/);
      return true;
    } },
    action("toggle", async () => {
      assert.equal(configured.postProcessing.enabled, true);
      assert.deepEqual(configured.postProcessing.model, model);
      assert.equal(configured.postProcessing.reasoning, "low");
      assert.deepEqual((await readSettings()).settings, configured);
    }),
  ]);
  assert.deepEqual(configured.postProcessing, { ...original.postProcessing, model, reasoning: "low", enabled: false });
  assert.deepEqual((await readSettings()).settings, configured);
});

test("cancelled model, reasoning, or enable confirmation leaves no partial configuration", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const original = structuredClone(configured);
  const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
  const script = await openMenu(configured, [
    action("model"), closePane,
    action("toggle"), closePane,
    action("toggle"), selectModel("provider-a"), closePane,
    action("toggle"), selectModel("provider-a"), selectReasoning("low"), confirmProvider(false),
  ]);
  assert.deepEqual(configured, original);
  assert.deepEqual(script.notifications, []);
  assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
});

test("a chosen model still requires explicit reasoning on enable, including when only one level is supported", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: false, model: otherModel, prompt: "Custom prompt" });
  await writeSettings(configured);
  const original = structuredClone(configured);
  await openMenu(configured, [
    action("toggle"), closePane,
    action("toggle", () => { assert.deepEqual(configured, original); }),
    selectReasoning("high", { levels: ["high"] }), confirmProvider(true, "provider-b", "high"),
  ], incompatibleModels);
  assert.deepEqual(configured.postProcessing, { ...original.postProcessing, enabled: true, reasoning: "high" });
  assert.deepEqual((await readSettings()).settings, configured);
});

test("enable requires replacing an unsupported level instead of silently clamping it", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: false, model: otherModel, reasoning: "low", prompt: "Custom prompt" });
  await writeSettings(configured);
  const original = structuredClone(configured);
  await openMenu(configured, [
    action("toggle"), closePane,
    action("toggle", () => { assert.deepEqual(configured, original); }),
    selectReasoning("high", { levels: ["high"] }), confirmProvider(false, "provider-b", "high"),
    action("toggle", () => { assert.deepEqual(configured, original); }),
    selectReasoning("high", { levels: ["high"] }), confirmProvider(true, "provider-b", "high"),
  ], incompatibleModels);
  assert.equal(configured.postProcessing.enabled, true);
  assert.equal(configured.postProcessing.reasoning, "high");
  assert.deepEqual((await readSettings()).settings, configured);
});

test("reasoning changes save immediately without enabling or accessing session thinking", async (t) => {
  isolatedSettings(t);
  for (const enabled of [false, true]) {
    const configured = settings({ enabled, model, reasoning: "low", prompt: "Prompt" });
    await writeSettings(configured);
    const script = await openMenu(configured, [
      action("reasoning"), selectReasoning("medium", { current: "low" }),
      action("reasoning", async () => {
        assert.equal(configured.postProcessing.reasoning, "medium");
        assert.equal(configured.postProcessing.enabled, enabled);
        assert.deepEqual((await readSettings()).settings, configured);
      }),
      selectReasoning("medium", { current: "medium" }),
    ]);
    assert.equal(script.notifications.length, 1); // Unchanged selection does not save.
    assert.match(script.notifications[0]!.message, /main session thinking level unchanged/);
  }
});

test("cancelling the standalone reasoning picker preserves missing and existing levels", async (t) => {
  const directory = isolatedSettings(t);
  for (const reasoning of [undefined, "low"] as const) {
    const configured = settings({ enabled: false, model, reasoning, prompt: "Prompt" });
    await writeSettings(configured);
    const original = structuredClone(configured);
    const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
    const script = await openMenu(configured, [action("reasoning"), closePane]);
    assert.deepEqual(configured, original);
    assert.deepEqual(script.notifications, []);
    assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
  }
});

test("reasoning picker offers only the model's supported subset, including mapped xhigh and max", async (t) => {
  isolatedSettings(t);
  const models: Models = [{
    ...model, name: "Mapped reasoning LLM", reasoning: true,
    thinkingLevelMap: { minimal: null, medium: null, high: null, xhigh: "high", max: "maximum" },
  }];
  const configured = settings({ enabled: false, model, prompt: "Prompt" });
  await writeSettings(configured);
  await openMenu(configured, [
    action("reasoning"), selectReasoning("xhigh", { levels: ["low", "xhigh", "max"] }),
    action("reasoning"), selectReasoning("max", { levels: ["low", "xhigh", "max"], current: "xhigh" }),
    action("toggle"), confirmProvider(true, "provider-a", "max"),
  ], models);
  assert.equal(configured.postProcessing.reasoning, "max");
  assert.equal(configured.postProcessing.enabled, true);
  assert.deepEqual((await readSettings()).settings, configured);
});

test("editing preserves the full prompt and reset restores the default immediately", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: false, model, reasoning: "low", prompt: "Original prompt\nLine two" });
  const edited = "  Correct only ASR mistakes.\nKeep names and original language.\n  ";
  await writeSettings(configured);
  await openMenu(configured, [
    action("prompt"),
    { type: "editor", run: (title, prefill) => {
      assert.match(title, /correction prompt/);
      assert.equal(prefill, configured.postProcessing.prompt);
      return edited;
    } },
    action("reset-prompt", async () => {
      assert.equal(configured.postProcessing.prompt, edited);
      assert.deepEqual((await readSettings()).settings, configured);
    }),
    { type: "confirm", run: (title) => {
      assert.match(title, /Reset correction prompt/);
      return true;
    } },
  ]);
  assert.deepEqual(configured.postProcessing, { enabled: false, model, reasoning: "low", prompt: DEFAULT_POST_PROCESSING_PROMPT });
  assert.deepEqual((await readSettings()).settings, configured);
});

test("cancelled prompt editing and reset, unchanged and empty edits do not save", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings({ enabled: true, model, reasoning: "low", prompt: "Full custom\nprompt" });
  await writeSettings(configured);
  const original = structuredClone(configured);
  const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
  const script = await openMenu(configured, [
    action("prompt"), { type: "editor", run: () => undefined },
    action("prompt"), { type: "editor", run: (_title, prefill) => prefill },
    action("prompt"), { type: "editor", run: () => " \n " },
    action("reset-prompt"), { type: "confirm", run: () => false },
  ]);
  assert.deepEqual(configured, original);
  assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
  assert.equal(script.notifications.length, 1);
  assert.match(script.notifications[0]!.message, /cannot be empty/);
});

test("enable reuses valid model and reasoning; enabled model switches preserve supported reasoning and confirm", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: false, model, reasoning: "low", prompt: DEFAULT_POST_PROCESSING_PROMPT });
  await writeSettings(configured);
  await openMenu(configured, [
    action("toggle"), confirmProvider(true),
    action("model"), selectModel("provider-b"), confirmProvider(false, "provider-b"),
    action("model", () => {
      assert.deepEqual(configured.postProcessing.model, model);
      assert.equal(configured.postProcessing.reasoning, "low");
    }),
    selectModel("provider-b"), confirmProvider(true, "provider-b"),
  ]);
  assert.equal(configured.postProcessing.enabled, true);
  assert.deepEqual(configured.postProcessing.model, otherModel);
  assert.equal(configured.postProcessing.reasoning, "low");
  assert.deepEqual((await readSettings()).settings, configured);
});

test("incompatible enabled model switch requires a new reasoning choice and commits model and level atomically", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: true, model, reasoning: "low", prompt: "Prompt" });
  await writeSettings(configured);
  const original = structuredClone(configured);
  const unchanged = async () => {
    assert.deepEqual(configured, original);
    assert.deepEqual((await readSettings()).settings, original);
  };
  await openMenu(configured, [
    action("model"), selectModel("provider-b"), closePane,
    action("model", unchanged), selectModel("provider-b"),
    selectReasoning("high", { levels: ["high"], check: unchanged }),
    confirmProvider(false, "provider-b", "high"),
    action("model", unchanged), selectModel("provider-b"),
    selectReasoning("high", { levels: ["high"], check: unchanged }),
    confirmProvider(true, "provider-b", "high"),
  ], incompatibleModels);
  assert.deepEqual(configured.postProcessing, { ...original.postProcessing, model: otherModel, reasoning: "high" });
  assert.deepEqual((await readSettings()).settings, configured);
});

test("disabled model switches preserve supported reasoning but clear incompatible reasoning", async (t) => {
  isolatedSettings(t);
  for (const reasoning of ["low", "high"] as const) {
    const configured = settings({ enabled: false, model, reasoning, prompt: "Prompt" });
    await writeSettings(configured);
    await openMenu(configured, [action("model"), selectModel("provider-b")], incompatibleModels);
    assert.deepEqual(configured.postProcessing.model, otherModel);
    assert.equal(configured.postProcessing.enabled, false);
    assert.equal(configured.postProcessing.reasoning, reasoning === "high" ? "high" : undefined);
    assert.deepEqual((await readSettings()).settings, configured);
  }
});

test("choosing the current model does not save or change reasoning", async (t) => {
  const directory = isolatedSettings(t);
  const configured = settings({ enabled: true, model, reasoning: "low", prompt: "Prompt" });
  await writeSettings(configured);
  const original = structuredClone(configured);
  const disk = await readFile(join(directory, "pi-voice.json"), "utf8");
  const script = await openMenu(configured, [action("model"), selectModel("provider-a")]);
  assert.deepEqual(script.notifications, []);
  assert.deepEqual(configured, original);
  assert.equal(await readFile(join(directory, "pi-voice.json"), "utf8"), disk);
});

const unusableModels: Models = [
  { provider: "provider-c", id: "non-reasoning", name: "Not a reasoning model", reasoning: false },
  {
    provider: "provider-d", id: "all-levels-disabled", name: "No usable reasoning levels", reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
  },
];

test("model picker excludes non-reasoning models and models with no supported non-off level", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  await openMenu(configured, [action("model"), selectModel("provider-a", ["provider-a/correction-model"])], [
    ...unusableModels,
    { ...model, name: "Correction LLM", reasoning: true },
  ]);
  assert.deepEqual(configured.postProcessing.model, model);
  assert.equal(configured.postProcessing.reasoning, undefined);
});

test("no reasoning-capable LLMs cannot enable correction or open a model picker", async (t) => {
  isolatedSettings(t);
  for (const models of [[], unusableModels]) {
    const configured = settings();
    await writeSettings(configured);
    const original = structuredClone(configured);
    const script = await openMenu(configured, [action("toggle"), action("model")], models);
    assert.equal(script.notifications.length, 2);
    for (const notification of script.notifications) {
      assert.match(notification.message, /No reasoning-capable LLMs available/);
      assert.equal(notification.type, "warning");
    }
    assert.deepEqual(configured, original);
    assert.deepEqual((await readSettings()).settings, configured);
  }
});

test("unavailable or non-reasoning chosen models cannot enable or select reasoning, with no session fallback", async (t) => {
  isolatedSettings(t);
  for (const chosen of [model, ...unusableModels]) {
    const configured = settings({ enabled: false, model: chosen, reasoning: "low", prompt: "Prompt" });
    await writeSettings(configured);
    const original = structuredClone(configured);
    const script = await openMenu(configured, [action("toggle"), action("reasoning")], unusableModels);
    assert.equal(script.notifications.length, 2);
    for (const notification of script.notifications) {
      assert.match(notification.message, /chosen LLM is unavailable|chosen LLM has no supported reasoning levels/);
      assert.equal(notification.type, "warning");
    }
    assert.deepEqual(configured, original);
    assert.deepEqual((await readSettings()).settings, configured);
  }
});

test("failed model, reasoning, enable, and enabled model-switch saves leave all live settings untouched", async (t) => {
  const directory = isolatedSettings(t);
  const scenarios: { initial?: PostProcessingSettings; steps: Step[]; models?: Models }[] = [
    { steps: [action("model"), selectModel("provider-a")] },
    { steps: [action("toggle"), selectModel("provider-a"), selectReasoning("low"), confirmProvider(true)] },
    {
      initial: { enabled: false, model, prompt: "Prompt" },
      steps: [action("reasoning"), selectReasoning("low")],
    },
    {
      initial: { enabled: true, model, reasoning: "low", prompt: "Prompt" },
      steps: [action("reasoning"), selectReasoning("high", { current: "low" })],
    },
    {
      initial: { enabled: true, model, reasoning: "low", prompt: "Prompt" },
      steps: [
        action("model"), selectModel("provider-b"), selectReasoning("high", { levels: ["high"] }),
        confirmProvider(true, "provider-b", "high"),
      ],
      models: incompatibleModels,
    },
  ];
  const path = join(directory, "pi-voice.json");
  await writeSettings(settings());
  await unlink(path);
  await mkdir(path); // A directory at the destination makes the atomic rename fail.
  for (const scenario of scenarios) {
    const configured = settings(scenario.initial);
    const original = structuredClone(configured);
    const script = await openMenu(configured, scenario.steps, scenario.models);
    assert.deepEqual(configured, original);
    assert.equal(script.notifications.length, 1);
    assert.equal(script.notifications[0]!.type, "error");
    assert.match(script.notifications[0]!.message, /Could not save settings/);
    assert.deepEqual(await readdir(directory), ["pi-voice.json"]);
  }
});

test("the settings model picker forwards post-processing and reasoning through ASR switches", async (t) => {
  isolatedSettings(t);
  const configured = settings({ enabled: true, model, reasoning: "low", prompt: "Keep my correction prompt" });
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
  assert.equal(await showSettingsMenu(sessionIndependentApi, script.ctx, configured, configured.shortcut), false);
  script.assertFinished();
  assert.equal(configured.model.id, target.id);
  assert.deepEqual(configured.postProcessing, original);
  assert.deepEqual((await readSettings()).settings, configured);
});
