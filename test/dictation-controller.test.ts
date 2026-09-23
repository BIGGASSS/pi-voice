import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationControllerOptions, type DictationState } from "../src/dictation-controller.js";
import { Deferred } from "../src/deferred.js";
import { settingsForModel } from "../src/settings.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { FakeCapture, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model");

const correctionSettings = {
  ...settings,
  postProcessing: {
    ...settings.postProcessing,
    enabled: true,
    reasoning: "low" as const,
    model: { provider: "local-correction", id: "dedicated-llm" },
  },
};

function harness(postProcess?: DictationControllerOptions["postProcess"]) {
  const service = fakeDictationService();
  const captures: FakeCapture[] = [];
  const states: DictationState[] = [];
  let now = 0;
  const controller = new DictationController(service, {
    createCapture: () => { const capture = new FakeCapture(); captures.push(capture); return capture; },
    now: () => now,
    onChange: (state) => states.push(state),
    postProcess,
  });
  return { controller, service, captures, states, time: (value: number) => { now = value; } };
}

test("prewarming, streaming chunks, final tail and timing have one lifecycle", async () => {
  const h = harness();
  h.controller.prepare(settings);
  const reservation = h.service.reservations[0]!;
  assert.equal(h.captures.length, 0);
  reservation.prepared.resolve();
  await nextTurn();
  assert.equal(h.controller.modelState, "ready");
  await h.controller.start(settings);
  assert.equal(h.service.reservations.length, 1);
  const capture = h.captures[0]!;
  capture.onFrame!(new Int16Array(8000).fill(100));
  capture.onFrame!(new Int16Array(512).fill(200));
  assert.equal(reservation.chunks.length, 1);
  h.time(60000); // Wall-clock recording time must not be reported as PCM duration.
  const submission = h.controller.stop();
  assert.equal(h.controller.stop(), submission);
  await nextTurn();
  assert.deepEqual(reservation.chunks.map((chunk) => chunk.length), [8000, 512]);
  assert.equal(reservation.pcm, capture.pcm);
  h.time(61500);
  reservation.result.resolve("hello");
  assert.deepEqual(await submission, { text: "hello", speechSeconds: 1, transcribeSeconds: 1.5 });
  assert.equal(capture.stops, 1);
  assert.equal(h.controller.state.phase, "result");
  await h.controller.dispose();
});

test("duplicate starts cannot open two microphones", async () => {
  const h = harness();
  await Promise.all([h.controller.start(settings), h.controller.start(settings)]);
  assert.equal(h.captures.length, 1);
  assert.equal(h.service.reservations.length, 1);
  await h.controller.dispose();
});

test("capture cancellation discards the tail and waits for native teardown", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  capture.stopGate = new Deferred();
  capture.onFrame!(new Int16Array(512));
  const oldCallback = capture.onFrame!;
  const cancelling = h.controller.cancel();
  assert.equal(h.controller.state.phase, "cancelling");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 1);
  oldCallback(new Int16Array(8000));
  assert.equal(h.service.reservations[0]!.chunks.length, 0);
  capture.stopGate.resolve({ pcm: capture.pcm });
  await cancelling;
  assert.equal(h.controller.state.phase, "idle");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 2);
  assert.equal(h.service.reservations[0]!.submissions, 0);
  await h.controller.dispose();
});

test("cancelling while stop is pending never submits the discarded recording", async () => {
  const h = harness();
  await h.controller.start(settings);
  h.captures[0]!.stopGate = new Deferred();
  const submission = h.controller.stop();
  const cancelling = h.controller.cancel();
  h.captures[0]!.stopGate.resolve({ pcm: new Float32Array(16000) });
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.service.reservations[0]!.submissions, 0);
  assert.equal(h.captures[0]!.stops, 1);
  await h.controller.dispose();
});

test("a cancelled transcription cannot publish a late successful result", async () => {
  const h = harness();
  await h.controller.start(settings);
  const submission = h.controller.stop();
  await nextTurn();
  const reservation = h.service.reservations[0]!;
  const cancelling = h.controller.cancel();
  assert.equal(reservation.signal?.aborted, true);
  reservation.result.resolve("late text");
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.states.some((state) => state.phase === "result"), false);
  await h.controller.dispose();
});

test("model preparation failure is retryable and stale readiness is ignored", async () => {
  const h = harness();
  h.controller.prepare(settings);
  h.service.reservations[0]!.prepared.reject(new Error("load failed"));
  await nextTurn();
  assert.equal(h.controller.state.phase, "error");
  await h.controller.start(settings);
  assert.equal(h.service.reservations[0]!.cancelled, 1);
  assert.equal(h.service.reservations.length, 2);
  assert.equal(h.controller.state.phase, "listening");
  await h.controller.cancel();
  const paints = h.states.length;
  h.service.reservations[1]!.prepared.resolve();
  await nextTurn();
  assert.equal(h.states.length, paints);
  await h.controller.dispose();
});

for (const failure of ["start", "stop"] as const) {
  test(`microphone ${failure} failure releases the reservation and allows retry`, async () => {
    const service = fakeDictationService();
    const capture = new FakeCapture();
    if (failure === "start") capture.startError = new Error("permission denied");
    else capture.stopError = new Error("device disconnected");
    const controller = new DictationController(service, { createCapture: () => capture });
    await controller.start(settings);
    if (failure === "stop") await controller.stop();
    assert.equal(controller.state.phase, "error");
    assert.equal(service.reservations[0]!.cancelled, 1);
    capture.startError = capture.stopError = undefined;
    await controller.start(settings);
    assert.equal(controller.state.phase, "listening");
    await controller.dispose();
  });
}

test("disposal is idempotent and silences pending preparation and capture callbacks", async () => {
  const h = harness();
  await h.controller.start(settings);
  const frame = h.captures[0]!.onFrame!;
  await Promise.all([h.controller.dispose(), h.controller.dispose()]);
  const before = h.states.length;
  h.service.reservations[0]!.prepared.resolve();
  frame(new Int16Array(8000));
  await h.controller.start(settings);
  await nextTurn();
  assert.equal(h.controller.state.phase, "disposed");
  assert.equal(h.states.length, before);
  assert.equal(h.captures[0]!.stops, 1);
  assert.equal(h.service.reservations[0]!.chunks.length, 0);
});

test("disposal before microphone startup never opens a device", async () => {
  const h = harness();
  const starting = h.controller.start(settings);
  await h.controller.dispose();
  await starting;
  assert.equal(h.captures.length, 0);
});

test("controller disposal resets streams and leaves the injected service usable", async () => {
  let resets = 0;
  const service = new TranscriptionService(() => ({
    async prepare() {},
    async startStream() {
      return { async feed() {}, async finalize() { return "streamed"; }, reset() { resets++; } };
    },
    async transcribe() { return "file text"; },
    async dispose() {},
  }));
  const controller = new DictationController(service, { createCapture: () => new FakeCapture() });
  controller.prepare(settings);
  await nextTurn();
  await controller.start(settings);
  await controller.dispose();
  assert.ok(resets > 0);
  assert.equal(await service.transcribeFile(settings, Float32Array.of(1)), "file text");
  await service.shutdown();
});

test("display failures do not interrupt feeding, submission, or cleanup", async () => {
  const service = fakeDictationService();
  const capture = new FakeCapture();
  const controller = new DictationController(service, {
    createCapture: () => capture,
    onChange: () => { throw new Error("render failed"); },
    onFrame: () => { throw new Error("meter failed"); },
  });
  await controller.start(settings);
  capture.onFrame!(new Int16Array(8000));
  assert.equal(service.reservations[0]!.chunks.length, 1);
  const submission = controller.stop();
  service.reservations[0]!.result.resolve("still works");
  assert.equal((await submission)?.text, "still works");
  await controller.dispose();
});

test("correction delays the result but not the reported ASR timing or PCM duration", async (t) => {
  const correction = new Deferred<string>();
  const calls: Parameters<NonNullable<DictationControllerOptions["postProcess"]>>[] = [];
  const h = harness((...args) => { calls.push(args); return correction.promise; });
  t.after(async () => { correction.resolve("cleanup"); await h.controller.dispose(); });
  await h.controller.start(correctionSettings);
  h.time(60_000);
  const submission = h.controller.stop();
  let settled = false;
  void submission.then(() => { settled = true; });
  await nextTurn();
  assert.equal(h.controller.state.phase, "transcribing");
  assert.equal(calls.length, 0);
  h.time(61_500);
  const reservation = h.service.reservations[0]!;
  const originalText = "  raw asr transcript\n第二行  ";
  reservation.result.resolve(originalText);
  await nextTurn();
  assert.equal(h.controller.state.phase, "post-processing");
  assert.equal(settled, false);
  assert.equal(h.states.some((state) => state.phase === "result"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], originalText);
  assert.equal(calls[0]![1], correctionSettings);
  assert.equal(calls[0]![2], reservation.signal);
  assert.equal(calls[0]![2].aborted, false);
  assert.equal(h.controller.stop(), submission);
  assert.equal(h.captures[0]!.stops, 1);

  // Neither start nor prepare may steal the reservation during correction.
  h.controller.prepare(settings);
  await Promise.all([h.controller.start(settings), h.controller.start(correctionSettings)]);
  assert.equal(h.controller.state.phase, "post-processing");
  assert.equal(h.service.reservations.length, 1);
  assert.equal(h.captures.length, 1);
  assert.equal(reservation.submissions, 1);
  assert.equal(calls.length, 1);
  h.time(90_000);
  correction.resolve("Corrected transcript.");
  assert.deepEqual(await submission, {
    text: "Corrected transcript.", originalText, speechSeconds: 1, transcribeSeconds: 1.5,
  });
  assert.deepEqual(h.states.filter((state) => state.phase === "result"), [{
    phase: "result",
    result: { text: "Corrected transcript.", originalText, speechSeconds: 1, transcribeSeconds: 1.5 },
  }]);
  assert.deepEqual(h.states.slice(-3).map((state) => state.phase), ["transcribing", "post-processing", "result"]);
});

for (const action of ["cancel", "dispose"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`${action} aborts correction and ignores its late ${outcome}`, async (t) => {
      const correction = new Deferred<string>();
      let signal: AbortSignal | undefined;
      const h = harness((_text, _settings, takeSignal) => {
        signal = takeSignal;
        return correction.promise; // Deliberately ignore the signal to test stale-result protection.
      });
      t.after(async () => { correction.resolve("cleanup"); await h.controller.dispose(); });
      await h.controller.start(correctionSettings);
      const submission = h.controller.stop();
      h.service.reservations[0]!.result.resolve("uncorrected take");
      await nextTurn();
      assert.equal(h.controller.state.phase, "post-processing");
      assert.ok(signal);
      const cleanup = h.controller[action]();
      assert.equal(signal.aborted, true);
      assert.equal(h.controller.state.phase, action === "cancel" ? "cancelling" : "disposed");
      const statesAfterAbort = h.states.length;
      if (outcome === "resolve") correction.resolve("Must never be published");
      else correction.reject(new Error("Late correction error"));
      assert.equal(await submission, undefined);
      await cleanup;
      assert.equal(h.controller.state.phase, action === "cancel" ? "idle" : "disposed");
      assert.equal(h.states.some((state) => state.phase === "result" || state.phase === "error"), false);
      assert.equal(h.captures[0]!.stops, 1);
      if (action === "dispose") {
        assert.equal(h.states.length, statesAfterAbort);
        await h.controller.start(correctionSettings);
        h.controller.prepare(correctionSettings);
        assert.equal(h.service.reservations.length, 1);
      } else {
        await h.controller.start(settings);
        const retry = h.controller.stop();
        h.service.reservations[1]!.result.resolve("new take");
        assert.equal((await retry)?.text, "new take");
      }
    });
  }
}

test("an abort-aware correction lets cancellation finish without publishing an error or raw text", async () => {
  const h = harness((_text, _settings, signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  await h.controller.start(correctionSettings);
  const submission = h.controller.stop();
  h.service.reservations[0]!.result.resolve("discard this raw transcript");
  await nextTurn();
  assert.equal(h.controller.state.phase, "post-processing");
  await h.controller.cancel();
  assert.equal(await submission, undefined);
  assert.equal(h.controller.state.phase, "idle");
  assert.equal(h.states.some((state) => state.phase === "result" || state.phase === "error"), false);
  await h.controller.dispose();
});

for (const [label, takeSettings, text] of [
  ["disabled", settings, "raw transcript"],
  ["empty", correctionSettings, ""],
  ["whitespace-only", correctionSettings, " \n\t "],
] as const) {
  test(`${label} transcript bypasses the correction hook and phase`, async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return "Should not be called"; });
    await h.controller.start(takeSettings);
    const submission = h.controller.stop();
    h.service.reservations[0]!.result.resolve(text);
    const result = await submission;
    assert.equal(result?.text, text);
    assert.equal(result?.originalText, undefined);
    assert.equal(calls, 0);
    assert.equal(h.states.some((state) => state.phase === "post-processing"), false);
    await h.controller.dispose();
  });
}

test("enabled correction without an injected processor still returns the ASR transcript", async () => {
  const h = harness();
  await h.controller.start(correctionSettings);
  const submission = h.controller.stop();
  h.service.reservations[0]!.result.resolve("original transcript");
  assert.equal((await submission)?.text, "original transcript");
  assert.equal(h.states.some((state) => state.phase === "post-processing"), false);
  await h.controller.dispose();
});

test("unchanged or fallback corrections still retain the original for comparison", async () => {
  const h = harness(async (text) => text);
  await h.controller.start(correctionSettings);
  const submission = h.controller.stop();
  const originalText = "  original ASR text\nwith whitespace  ";
  h.service.reservations[0]!.result.resolve(originalText);
  const result = await submission;
  assert.equal(result?.text, originalText);
  assert.equal(result?.originalText, originalText);
  await h.controller.dispose();
});

test("failed ASR never enters correction", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return "unused"; });
  await h.controller.start(correctionSettings);
  const submission = h.controller.stop();
  const cause = new Error("ASR failed");
  h.service.reservations[0]!.result.reject(cause);
  assert.equal(await submission, undefined);
  assert.equal(calls, 0);
  assert.deepEqual(h.controller.state, { phase: "error", stage: "transcription", cause });
  await h.controller.dispose();
});
