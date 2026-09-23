import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clearTranscribeWidget, showDictationResult } from "../src/visualizer.js";
import { testTheme } from "./ui-helpers.js";

function harness(hasUI = true) {
  const pasted: string[] = [];
  const notifications: { message: string; type: string }[] = [];
  const widgets: (string[] | undefined)[] = [];
  const ctx = {
    hasUI,
    ui: {
      theme: testTheme(),
      pasteToEditor: (text: string) => pasted.push(text),
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
    },
  } as unknown as ExtensionContext;
  return { ctx, pasted, notifications, widgets };
}

const timing = { speechSeconds: 10, transcribeSeconds: 1 };

test("only final text is pasted; the full unmodified original is shown separately", () => {
  const h = harness();
  const originalText = "  original ASR result\n第二行\n" + "Long transcript. ".repeat(1000);
  const text = "Corrected transcript.";
  showDictationResult(h.ctx, { text, originalText, ...timing });
  assert.deepEqual(h.pasted, [text]);
  assert.deepEqual(h.notifications, [{ message: `Original ASR transcript:\n${originalText}`, type: "info" }]);
  assert.match(h.widgets[0]!.join("\n"), /Transcribed 10\.0s of audio in 1\.0s/);
  // Clearing the timed status widget does not clear the comparison notification.
  clearTranscribeWidget(h.ctx);
  assert.equal(h.widgets.at(-1), undefined);
  assert.equal(h.notifications.length, 1);
});

test("unchanged or fallback output still shows the original", () => {
  const h = harness();
  showDictationResult(h.ctx, { text: "Same text", originalText: "Same text", ...timing });
  assert.deepEqual(h.pasted, ["Same text"]);
  assert.deepEqual(h.notifications, [{ message: "Original ASR transcript:\nSame text", type: "info" }]);
});

test("without post-processing there is no redundant original transcript notice", () => {
  const h = harness();
  showDictationResult(h.ctx, { text: "Local ASR result", ...timing });
  assert.deepEqual(h.pasted, ["Local ASR result"]);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.widgets.length, 1);
});

test("headless contexts do not receive transcript UI calls", () => {
  const h = harness(false);
  showDictationResult(h.ctx, { text: "Corrected", originalText: "Raw", ...timing });
  assert.deepEqual(h.pasted, []);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.widgets, []);
});
