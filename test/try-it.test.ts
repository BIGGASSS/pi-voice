import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { needsFasterModel, TryItPane } from "../src/try-it.js";
import type { TranscribeSettings } from "../src/settings.js";
import type { TranscriptionService } from "../src/transcription-service.js";
import { keybindings, stripAnsi, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

const settings: TranscribeSettings = {
  version: 1,
  backend: { type: "transcribe-cpp" },
  shortcut: "ctrl+alt+z",
  preferredLanguages: ["en"],
  transcriptionLanguage: "en",
  chineseOutput: "simplified",
  microphone: { type: "system-default" },
  model: {
    source: "catalog",
    id: "parakeet-unified-en-0.6b",
    path: "/tmp/model.gguf",
  },
};

function pendingService(): TranscriptionService {
  return {
    reserveDictation: () => ({
      ready: new Promise<void>(() => {}),
      feed() {},
      submit: async () => "",
      cancel() {},
    }),
  } as unknown as TranscriptionService;
}

function readyService(transcript: string): TranscriptionService {
  return {
    reserveDictation: () => ({
      ready: Promise.resolve(),
      feed() {},
      submit: async () => transcript,
      cancel() {},
    }),
  } as unknown as TranscriptionService;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Try It renders its configured controls", async () => {
  const pane = new TryItPane(
    testTui(24),
    testTheme(),
    keybindings(),
    settings,
    pendingService(),
    () => undefined,
  );
  const body = stripAnsi(pane.render(80).join("\n"));
  const lines = body.split("\n");
  const shortcutLine = lines.find((line) => line.includes("Shortcut:"));
  const microphoneLine = lines.find((line) => line.includes("Microphone:"));
  const modelLine = lines.find((line) => line.includes("Model:"));
  assert.ok(shortcutLine && microphoneLine && modelLine);
  assert.equal(shortcutLine.indexOf("Ctrl"), microphoneLine.indexOf("System default"));
  assert.equal(shortcutLine.indexOf("Ctrl"), modelLine.indexOf("Parakeet Unified"));
  await pane.dispose();
});

test("Try It replaces the meter with the completion summary above the transcript", async () => {
  const pane = new TryItPane(
    testTui(24),
    testTheme(),
    keybindings(),
    settings,
    readyService("hello"),
    () => undefined,
    {
      createCapture: () => ({
        start() {},
        stop: async () => ({ pcm: new Float32Array(16_000) }),
      }) as never,
    },
  );

  const shortcut = "\x1b[122;7u"; // Kitty protocol: Ctrl+Alt+Z
  pane.handleInput(shortcut);
  await settle();
  assert.match(stripAnsi(pane.render(80).join("\n")), /▁▁▁/);

  pane.handleInput(shortcut);
  await settle();
  const lines = stripAnsi(pane.render(80).join("\n")).split("\n");
  const summary = lines.findIndex((line) => line.trimStart().startsWith("Transcribed "));
  assert.ok(summary >= 0);
  assert.match(lines[summary + 1] ?? "", /^─+$/);
  assert.equal(lines[summary + 2]?.trim(), "hello");
  assert.match(lines[summary + 3] ?? "", /^─+$/);
  await pane.dispose();
});

test("Try It maps the settings shortcuts to host actions", async () => {
  const results: string[] = [];
  for (const [key, action] of [["m", "microphone"], ["s", "shortcut"], ["c", "model"]] as const) {
    const pane = new TryItPane(
      testTui(24),
      testTheme(),
      keybindings(),
      settings,
      pendingService(),
      (result) => results.push(result.action),
    );
    pane.handleInput(key);
    pane.handleInput(key);
    await pane.dispose();
    assert.equal(results.at(-1), action);
  }
});

test("Try It speed nudge ignores short takes", () => {
  assert.equal(needsFasterModel(30, 6), true);
  assert.equal(needsFasterModel(30, 5), false);
  assert.equal(needsFasterModel(3, 2), false);
  assert.equal(needsFasterModel(30, 0.3), false);
});
