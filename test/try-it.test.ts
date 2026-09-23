import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Deferred } from "../src/deferred.js";
import type { DictationControllerOptions } from "../src/dictation-controller.js";
import { settingsForModel } from "../src/settings.js";
import { needsFasterModel, TryItPane, type TryItResult } from "../src/try-it.js";
import { FakeCapture, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");
const RECORD = "\x07"; // ctrl+g
const ESC = "\x1b";

function harness(postProcess: DictationControllerOptions["postProcess"], enabled = true) {
  const service = fakeDictationService();
  const captures: FakeCapture[] = [];
  const results: TryItResult[] = [];
  let now = 0;
  const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/try-it-model", {
    shortcut: "ctrl+g",
    postProcessing: {
      enabled, model: { provider: "test-correction", id: "dedicated-llm" },
      prompt: "Conservatively correct this transcript.",
    },
  });
  const pane = new TryItPane(testTui(32), testTheme(), keybindings(), settings, service,
    (result) => results.push(result), {
      createCapture: () => {
        const capture = new FakeCapture();
        capture.pcm = new Float32Array(160_000);
        captures.push(capture);
        return capture;
      },
      postProcess,
      now: () => now,
    });
  return { pane, service, captures, results, render: () => pane.render(80).join("\n"), time: (value: number) => { now = value; } };
}

async function recordAndTranscribe(h: ReturnType<typeof harness>, text = "raw uncorrected transcript"): Promise<void> {
  h.render();
  await nextTurn(); // Let the first-render preparation run without native work.
  h.pane.handleInput(RECORD);
  await nextTurn();
  const reservation = h.service.reservations.at(-1)!;
  reservation.prepared.resolve();
  assert.equal(h.captures.at(-1)!.starts, 1);
  h.time(10_000);
  h.pane.handleInput(RECORD);
  await nextTurn();
  assert.match(h.render(), /Transcribing…/);
  h.time(11_000);
  reservation.result.resolve(text);
  await nextTurn();
}

test("speed nudge ignores takes that are too short to judge", () => {
  assert.equal(needsFasterModel(30, 6), true);
  assert.equal(needsFasterModel(30, 5), false);
  assert.equal(needsFasterModel(3, 2), false);
  assert.equal(needsFasterModel(30, 0.3), false);
});

test("Try It shows Correcting transcript, stays busy, and only previews the final correction", async (t) => {
  const correction = new Deferred<string>();
  const h = harness(() => correction.promise);
  t.after(async () => { correction.resolve("cleanup"); await h.pane.dispose(); });
  await recordAndTranscribe(h);
  const correcting = h.render();
  assert.match(correcting, /Correcting transcript…/);
  assert.match(correcting, /escape.*cancel/);
  assert.doesNotMatch(correcting, /raw uncorrected transcript|looks good|Slow on this machine/);
  for (const input of [RECORD, RECORD, "s", "m", "c", "\r"]) h.pane.handleInput(input);
  await nextTurn();
  assert.equal(h.captures.length, 1);
  assert.equal(h.service.reservations.length, 1);
  assert.deepEqual(h.results, []);
  assert.match(h.render(), /Correcting transcript…/);

  h.time(90_000); // Long LLM latency must not make the local ASR model look slow.
  correction.resolve("Corrected transcript only.");
  await nextTurn();
  const result = h.render();
  assert.match(result, /Corrected transcript only\./);
  assert.match(result, /Transcribed 10\.0s of audio in 1\.0s/);
  assert.match(result, /looks good/);
  assert.doesNotMatch(result, /Correcting transcript|raw uncorrected transcript|Slow on this machine/);
  h.pane.handleInput("\r");
  assert.deepEqual(h.results, [{ action: "done" }]);
});

test("Escape during correction aborts the take instead of leaving or showing raw text", async (t) => {
  const correction = new Deferred<string>();
  let signal: AbortSignal | undefined;
  const h = harness((_text, _settings, takeSignal) => {
    signal = takeSignal;
    takeSignal.addEventListener("abort", () => correction.reject(takeSignal.reason), { once: true });
    return correction.promise;
  });
  t.after(async () => { correction.resolve("cleanup"); await h.pane.dispose(); });
  await recordAndTranscribe(h);
  assert.match(h.render(), /Correcting transcript…/);
  assert.ok(signal);
  h.pane.handleInput(ESC);
  assert.equal(signal.aborted, true);
  await nextTurn();
  assert.deepEqual(h.results, []);
  assert.doesNotMatch(h.render(), /Correcting transcript|raw uncorrected transcript|Transcription failed|looks good/);
  assert.match(h.render(), /Your transcript will appear here/);
  assert.equal(h.captures[0]!.stops, 1);
  // Cancelling a take keeps Try It open; Escape from idle is still Skip.
  h.pane.handleInput(ESC);
  assert.deepEqual(h.results, [{ action: "skip" }]);
});

for (const action of ["escape", "dispose"] as const) {
  test(`Try It ${action} ignores a late correction even if it ignores abort`, async (t) => {
    const correction = new Deferred<string>();
    let signal: AbortSignal | undefined;
    const h = harness((_text, _settings, takeSignal) => {
      signal = takeSignal;
      return correction.promise;
    });
    t.after(async () => { correction.resolve("cleanup"); await h.pane.dispose(); });
    await recordAndTranscribe(h);
    assert.ok(signal);
    let disposal: Promise<void> | undefined;
    if (action === "escape") h.pane.handleInput(ESC);
    else disposal = h.pane.dispose();
    assert.equal(signal.aborted, true);
    correction.resolve("Late correction must be discarded");
    await disposal;
    await nextTurn();
    assert.deepEqual(h.results, []);
    assert.doesNotMatch(h.render(), /Late correction|raw uncorrected transcript|looks good|Correcting transcript/);
  });
}

for (const [label, text, enabled] of [["disabled", "uncorrected output", false], ["empty", "", true]] as const) {
  test(`Try It skips correction for ${label} transcripts`, async (t) => {
    let calls = 0;
    const h = harness(async () => { calls++; return "unexpected correction"; }, enabled);
    t.after(() => h.pane.dispose());
    await recordAndTranscribe(h, text);
    assert.equal(calls, 0);
    assert.doesNotMatch(h.render(), /Correcting transcript|unexpected correction/);
    assert.match(h.render(), enabled ? /No speech detected/ : /uncorrected output/);
    h.pane.handleInput(ESC);
    assert.deepEqual(h.results, [{ action: "done" }]);
  });
}
