import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Deferred } from "../src/deferred.js";
import { createTranscriptPostProcessor, postProcessTranscript } from "../src/post-processing.js";
import { settingsForModel, type PostProcessingSettings } from "../src/settings.js";
import { nextTurn } from "./helpers.js";

type Registry = ExtensionContext["modelRegistry"];
type Provider = NonNullable<ReturnType<Registry["getProvider"]>>;
type StreamArgs = Parameters<Provider["streamSimple"]>;
type Model = StreamArgs[0];
type Response = Awaited<ReturnType<ReturnType<Provider["streamSimple"]>["result"]>>;
type Auth = Awaited<ReturnType<Registry["getApiKeyAndHeaders"]>>;
type RegistryApi = "provider" | "registry";

const model: Model = {
  provider: "custom-local-provider",
  id: "dedicated/correction-model",
  name: "Correction model",
  api: "custom-correction-api",
  baseUrl: "https://must-not-be-called.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const settings: PostProcessingSettings = {
  enabled: true,
  model: { provider: model.provider, id: model.id },
  prompt: "Only fix transcription errors. Preserve the original language.\nReturn only corrected text.",
};
const raw = "  bonjour le monde\nceci est la transcription brute  ";

function response(overrides: Partial<Response> = {}): Response {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Bonjour le monde." }],
    stopReason: "stop", timestamp: 123,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

/** No pi-ai dispatcher: both Pi API shapes expose a synchronous stream with .result(). */
class FakeRegistry {
  readonly lookups: [string, string][] = [];
  readonly providerLookups: string[] = [];
  readonly authModels: Model[] = [];
  readonly requests: StreamArgs[] = [];
  readonly warnings: string[] = [];
  readonly registry: Registry;
  selected: Model | undefined = model;
  providerAvailable = true;
  resultCalls = 0;
  streamError: Error | undefined;
  auth: () => Promise<Auth> = async () => ({ ok: true });
  result: () => Promise<Response> = async () => response();

  constructor(api: RegistryApi = "provider") {
    const streamSimple = (...args: StreamArgs) => {
      this.requests.push(args);
      if (this.streamError) throw this.streamError;
      return { result: () => { this.resultCalls++; return this.result(); } };
    };
    const provider = { streamSimple };
    // The only registry cast omits unrelated Pi runtime/private members.
    this.registry = {
      find: (provider: string, id: string) => {
        this.lookups.push([provider, id]);
        return this.selected?.provider === provider && this.selected.id === id ? this.selected : undefined;
      },
      getProvider: (id: string) => {
        this.providerLookups.push(id);
        return this.providerAvailable && id === this.selected?.provider ? provider : undefined;
      },
      getApiKeyAndHeaders: async (selected: Model) => {
        this.authModels.push(selected);
        return this.auth();
      },
      ...(api === "registry" ? { streamSimple } : {}),
    } as unknown as Registry;
  }

  process(text = raw, overrides: Partial<PostProcessingSettings> = {}, signal = new AbortController().signal, timeoutMs?: number) {
    return postProcessTranscript(text, { ...settings, ...overrides }, this.registry, signal, {
      onWarning: (message) => this.warnings.push(message), timeoutMs,
    });
  }

  assertFallback(reason: RegExp): void {
    assert.equal(this.warnings.length, 1);
    assert.match(this.warnings[0]!, reason);
    assert.match(this.warnings[0]!, /Using the original ASR transcript/);
  }
}

for (const api of ["provider", "registry"] as const) {
  test(`${api} API uses the exact dedicated custom model and only prompt plus raw transcript`, async () => {
    const h = new FakeRegistry(api);
    h.result = async () => response({ content: [
      { type: "thinking", thinking: "Private reasoning must never be pasted." },
      { type: "text", text: "  Bonjour le monde." },
      { type: "toolCall", id: "ignored", name: "not-a-transcript", arguments: { secret: true } },
      { type: "text", text: "Ceci est la transcription.  \n" },
    ] });
    const before = Date.now();
    assert.equal(await h.process(), "Bonjour le monde.\nCeci est la transcription.");
    assert.deepEqual(h.lookups, [[model.provider, model.id]]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.resultCalls, 1);
    const [selected, context, options] = h.requests[0]!;
    assert.equal(selected, model);
    const timestamp = context.messages[0]!.timestamp;
    assert.ok(timestamp >= before && timestamp <= Date.now());
    assert.deepEqual(context, {
      systemPrompt: settings.prompt,
      messages: [{ role: "user", content: raw, timestamp }],
    });
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.cacheRetention, "none");
    assert.equal(options.maxRetries, 0);
    assert.equal(options.sessionId, undefined);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(h.providerLookups, api === "provider" ? [model.provider] : []);
    assert.deepEqual(h.authModels, api === "provider" ? [model] : []);
  });

  for (const failure of ["stream throws", "result rejects"] as const) {
    test(`${api} API falls back when ${failure}`, async () => {
      const h = new FakeRegistry(api);
      if (failure === "stream throws") h.streamError = new Error("Provider unavailable");
      else h.result = async () => { throw new Error("Provider unavailable"); };
      assert.equal(await h.process(), raw);
      assert.equal(h.requests.length, 1);
      h.assertFallback(/Provider unavailable/);
    });
  }

  test(`${api} API times out even when the provider ignores its signal`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = new FakeRegistry(api);
    const late = new Deferred<Response>();
    h.result = () => late.promise;
    const abort = new AbortController();
    const processing = h.process(raw, {}, abort.signal);
    let settled = false;
    void processing.then(() => { settled = true; });
    await nextTurn();
    const signal = h.requests[0]![2]!.signal!;
    t.mock.timers.tick(29_999);
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(settled, true, "Timeout must not wait for .result()");
    assert.equal(await processing, raw);
    assert.equal(signal.aborted, true);
    assert.equal(abort.signal.aborted, false);
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    h.assertFallback(/timed out/i);
    late.resolve(response());
    await nextTurn();
    h.assertFallback(/timed out/i);
  });

  for (const lateOutcome of ["success", "failure"] as const) {
    test(`${api} API cancels promptly without raw fallback, warning, or late ${lateOutcome}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const h = new FakeRegistry(api);
      const late = new Deferred<Response>();
      h.result = () => late.promise;
      const abort = new AbortController();
      const reason = new Error("User discarded this take");
      const processing = h.process(raw, {}, abort.signal);
      let settled = false;
      void processing.then(() => { settled = true; }, () => { settled = true; });
      const rejected = assert.rejects(processing, (error) => error === reason);
      await nextTurn();
      const signal = h.requests[0]![2]!.signal!;
      abort.abort(reason);
      await nextTurn();
      assert.equal(settled, true, "Cancellation must not wait for the provider or timeout");
      await rejected;
      assert.equal(signal.aborted, true);
      assert.equal(signal.reason, reason);
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      assert.deepEqual(h.warnings, []);
      if (lateOutcome === "success") late.resolve(response());
      else late.reject(new Error("Late provider failure"));
      t.mock.timers.tick(60_000);
      await nextTurn();
      assert.deepEqual(h.warnings, []);
    });
  }
}

const resolvedAuths: Extract<Auth, { ok: true }>[] = [
  { ok: true, apiKey: "resolved-oauth-token", headers: { "X-Custom-Auth": "session-token" }, env: { REGION: "test-region" } },
  { ok: true, headers: { "X-Local": "keyless" }, env: { ENDPOINT: "local" } },
  { ok: true },
];
for (const auth of resolvedAuths) {
  test(`Pi 0.83 forwards resolved auth, headers, and env (${"apiKey" in auth ? "keyed" : "headers" in auth ? "keyless with options" : "keyless"})`, async () => {
    const h = new FakeRegistry();
    h.auth = async () => auth;
    assert.equal(await h.process(), "Bonjour le monde.");
    assert.deepEqual(h.authModels, [model]);
    const options = h.requests[0]![2]!;
    assert.deepEqual(options, {
      signal: options.signal, cacheRetention: "none", maxRetries: 0,
      apiKey: "apiKey" in auth ? auth.apiKey : undefined,
      headers: "headers" in auth ? auth.headers : undefined,
      env: "env" in auth ? auth.env : undefined,
    });
    assert.deepEqual(h.warnings, []);
  });
}

test("modern registry streamSimple owns auth and dispatch without consulting the legacy provider", async () => {
  const h = new FakeRegistry("registry");
  h.providerAvailable = false;
  h.auth = async () => { throw new Error("Legacy auth must not run"); };
  assert.equal(await h.process(), "Bonjour le monde.");
  assert.deepEqual(h.providerLookups, []);
  assert.deepEqual(h.authModels, []);
  const options = h.requests[0]![2]!;
  assert.deepEqual(options, { signal: options.signal, cacheRetention: "none", maxRetries: 0 });
});

for (const [label, text, overrides] of [
  ["disabled", raw, { enabled: false }],
  ["empty", "", {}],
  ["whitespace-only", " \n\t ", {}],
] satisfies [string, string, Partial<PostProcessingSettings>][]) {
  test(`${label} correction bypasses model lookup, auth, and streaming`, async () => {
    const h = new FakeRegistry();
    assert.equal(await h.process(text, overrides), text);
    assert.deepEqual(h.lookups, []);
    assert.deepEqual(h.providerLookups, []);
    assert.deepEqual(h.authModels, []);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.warnings, []);
  });
}

test("already aborted requests reject before lookup, including disabled or empty correction", async () => {
  const h = new FakeRegistry();
  const abort = new AbortController();
  const reason = new Error("Already cancelled");
  abort.abort(reason);
  for (const [text, enabled] of [[raw, true], [raw, false], ["", true]] as const) {
    await assert.rejects(h.process(text, { enabled }, abort.signal), (error) => error === reason);
  }
  assert.deepEqual(h.lookups, []);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.warnings, []);
});

test("missing dedicated selection never falls back to another model", async () => {
  const h = new FakeRegistry();
  assert.equal(await h.process(raw, { model: undefined }), raw);
  assert.deepEqual(h.lookups, []);
  assert.deepEqual(h.requests, []);
  h.assertFallback(/Choose a post-processing LLM/);
});

for (const selected of [undefined, { provider: "different-provider", id: model.id }, { provider: model.provider, id: "different-id" }]) {
  test(`unavailable exact model falls back (${selected ? `${selected.provider}/${selected.id}` : "removed"})`, async () => {
    const h = new FakeRegistry();
    if (!selected) h.selected = undefined;
    assert.equal(await h.process(raw, selected ? { model: selected } : {}), raw);
    assert.deepEqual(h.lookups, [[selected?.provider ?? model.provider, selected?.id ?? model.id]]);
    assert.deepEqual(h.providerLookups, []);
    assert.deepEqual(h.authModels, []);
    assert.deepEqual(h.requests, []);
    h.assertFallback(/selected post-processing LLM is unavailable/);
  });
}

test("missing registered provider warns and preserves the raw ASR result", async () => {
  const h = new FakeRegistry();
  h.providerAvailable = false;
  assert.equal(await h.process(), raw);
  assert.deepEqual(h.authModels, []);
  assert.deepEqual(h.requests, []);
  h.assertFallback(/selected provider is unavailable/);
});

for (const failure of ["not configured", "auth rejects"] as const) {
  test(`${failure} auth warns without starting a provider stream`, async () => {
    const h = new FakeRegistry();
    h.auth = async () => {
      if (failure === "auth rejects") throw new Error("Token refresh failed");
      return { ok: false, error: "No configured credentials" };
    };
    assert.equal(await h.process(), raw);
    assert.deepEqual(h.authModels, [model]);
    assert.deepEqual(h.requests, []);
    h.assertFallback(failure === "auth rejects" ? /Token refresh failed/ : /No configured credentials/);
  });
}

for (const stopReason of ["error", "length", "aborted", "toolUse", "pending"] as const) {
  test(`stopReason ${stopReason} never publishes partial corrected text`, async () => {
    const h = new FakeRegistry();
    h.result = async () => response({ stopReason, content: [{ type: "text", text: "Partial correction" }] });
    assert.equal(await h.process(), raw);
    h.assertFallback(new RegExp(`did not finish \\(${stopReason}\\)`));
  });
}

for (const [label, content] of [
  ["no content", []],
  ["blank text", [{ type: "text", text: " \n\t " }]],
  ["thinking only", [{ type: "thinking", thinking: "This is not the corrected transcript" }]],
] satisfies [string, Response["content"]][]) {
  test(`${label} output warns and falls back without losing whitespace in the ASR text`, async () => {
    const h = new FakeRegistry();
    h.result = async () => response({ content });
    assert.equal(await h.process(), raw);
    h.assertFallback(/no corrected text/);
  });
}

for (const interruption of ["timeout", "cancel"] as const) {
  test(`${interruption} also interrupts unresolved auth and never starts a late stream`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = new FakeRegistry();
    const auth = new Deferred<Auth>();
    h.auth = () => auth.promise;
    const abort = new AbortController();
    const reason = new Error("Cancelled during auth");
    const processing = h.process(raw, {}, abort.signal, 50);
    let settled = false;
    void processing.then(() => { settled = true; }, () => { settled = true; });
    const completion = interruption === "cancel"
      ? assert.rejects(processing, (error) => error === reason)
      : processing.then((text) => { assert.equal(text, raw); });
    assert.deepEqual(h.authModels, [model]);
    if (interruption === "timeout") t.mock.timers.tick(50);
    else abort.abort(reason);
    await nextTurn();
    assert.equal(settled, true, "Auth must be covered by the cancellation/timeout race");
    await completion;
    if (interruption === "timeout") h.assertFallback(/timed out/i);
    else assert.deepEqual(h.warnings, []);
    auth.resolve({ ok: true, apiKey: "too late" });
    await nextTurn();
    assert.deepEqual(h.requests, []);
  });
}

test("successful correction cleans up its timeout and cancellation listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = new FakeRegistry();
  const abort = new AbortController();
  assert.equal(await h.process(raw, {}, abort.signal, 20), "Bonjour le monde.");
  const signal = h.requests[0]![2]!.signal!;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  abort.abort();
  t.mock.timers.tick(100);
  await nextTurn();
  assert.equal(signal.aborted, false);
  assert.deepEqual(h.warnings, []);
});

test("a throwing notification cannot discard a successful ASR transcript", async () => {
  const h = new FakeRegistry();
  h.result = async () => { throw "Provider failure without Error"; };
  let warnings = 0;
  assert.equal(await postProcessTranscript(raw, settings, h.registry, new AbortController().signal, {
    onWarning: (message) => {
      warnings++;
      assert.match(message, /Provider failure without Error/);
      throw new Error("UI notification failed");
    },
  }), raw);
  assert.equal(warnings, 1);
});

test("context adapter uses the current registry/settings, never the session model, history, or editor", async () => {
  const first = new FakeRegistry();
  const second = new FakeRegistry("registry");
  second.selected = { ...model, provider: "new-provider", id: "new-correction-model" };
  const notifications: { message: string; type: string }[] = [];
  const ctx = {
    modelRegistry: first.registry,
    get model() { return assert.fail("Do not use the active session model"); },
    get sessionManager() { return assert.fail("Do not read conversation history"); },
    ui: {
      getEditorText: () => assert.fail("Do not read the editor"),
      notify: (message: string, type: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
  const process = createTranscriptPostProcessor(ctx);
  const transcriptionSettings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/asr-only", { postProcessing: settings });
  assert.equal(await process(raw, transcriptionSettings, new AbortController().signal), "Bonjour le monde.");
  assert.deepEqual(first.lookups, [[model.provider, model.id]]);
  ctx.modelRegistry = second.registry;
  const updated = { ...transcriptionSettings, postProcessing: { ...settings, model: second.selected, prompt: "Updated correction prompt" } };
  assert.equal(await process("second take", updated, new AbortController().signal), "Bonjour le monde.");
  assert.deepEqual(second.lookups, [[second.selected.provider, second.selected.id]]);
  assert.deepEqual(second.requests[0]![1], {
    systemPrompt: "Updated correction prompt",
    messages: [{ role: "user", content: "second take", timestamp: second.requests[0]![1].messages[0]!.timestamp }],
  });
  assert.equal(first.requests.length, 1);
  assert.equal(notifications.length, 0);
  second.streamError = new Error("New registry failed");
  assert.equal(await process(raw, updated, new AbortController().signal), raw);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.type, "warning");
  assert.match(notifications[0]!.message, /New registry failed.*Using the original ASR transcript/);
});
