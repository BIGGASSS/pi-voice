import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DictationControllerOptions } from "./dictation-controller.js";
import type { PostProcessingSettings } from "./settings.js";

type ModelRegistry = ExtensionContext["modelRegistry"];
type Provider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;
type Model = Parameters<Provider["streamSimple"]>[0];
type ModelContext = Parameters<Provider["streamSimple"]>[1];

const CORRECTION_TIMEOUT_MS = 30_000;

type PostProcessingOptions = {
  onWarning?: (message: string) => void;
  timeoutMs?: number;
};

async function correctTranscript(
  registry: ModelRegistry,
  model: Model,
  context: ModelContext,
  signal: AbortSignal,
) {
  const options = { signal, cacheRetention: "none" as const, maxRetries: 0 };
  // Current Pi resolves auth and configured/custom providers at request time.
  const streamingRegistry: ModelRegistry & Partial<Pick<Provider, "streamSimple">> = registry;
  if (streamingRegistry.streamSimple) {
    return streamingRegistry.streamSimple(model, context, options).result();
  }

  // Pi 0.83 exposes provider streams and auth separately. Use the registered
  // provider, not a global API dispatcher, so custom/local providers work too.
  const provider = registry.getProvider(model.provider);
  if (!provider) throw new Error("The selected provider is unavailable");
  const auth = await registry.getApiKeyAndHeaders(model);
  signal.throwIfAborted();
  if (!auth.ok) throw new Error(auth.error);
  return provider.streamSimple(model, context, {
    ...options, apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
  }).result();
}

/** Never lose a successful ASR result to a failed optional correction request. */
export async function postProcessTranscript(
  text: string,
  settings: PostProcessingSettings,
  registry: ModelRegistry,
  signal: AbortSignal,
  options: PostProcessingOptions = {},
): Promise<string> {
  signal.throwIfAborted();
  if (!settings.enabled || !text.trim()) return text;

  const request = new AbortController();
  const onAbort = () => request.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => request.abort(new Error("Correction timed out")),
    options.timeoutMs ?? CORRECTION_TIMEOUT_MS,
  );
  let removeAbortListener: (() => void) | undefined;
  try {
    // Race even auth resolution and providers that ignore abort. Cancellation
    // and shutdown must not wait indefinitely or publish a late response.
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(request.signal.reason);
      request.signal.addEventListener("abort", rejectAbort, { once: true });
      removeAbortListener = () => request.signal.removeEventListener("abort", rejectAbort);
      if (request.signal.aborted) rejectAbort();
    });
    const correction = async (): Promise<string> => {
      request.signal.throwIfAborted();
      const selected = settings.model;
      if (!selected) throw new Error("Choose a post-processing LLM in /voice-settings");
      const model = registry.find(selected.provider, selected.id);
      if (!model) throw new Error("The selected post-processing LLM is unavailable");
      const response = await correctTranscript(registry, model, {
        systemPrompt: settings.prompt,
        // No session history, editor contents, tools, or audio are sent.
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
      }, request.signal);
      request.signal.throwIfAborted();
      if (response.stopReason !== "stop") {
        throw new Error(`Correction did not finish (${response.stopReason})`);
      }
      const corrected = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!corrected) throw new Error("The LLM returned no corrected text");
      return corrected;
    };
    const corrected = await Promise.race([correction(), aborted]);
    signal.throwIfAborted();
    return corrected;
  } catch (error) {
    // Explicit cancellation discards the entire take, rather than pasting raw
    // text after the user pressed Escape or shut down Pi.
    signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    try {
      options.onWarning?.(`Transcript correction failed: ${reason}. Using the original ASR transcript.`);
    } catch { /* A notification failure must not lose the transcript either. */ }
    return text;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    removeAbortListener?.();
  }
}

export function createTranscriptPostProcessor(
  ctx: ExtensionContext,
): NonNullable<DictationControllerOptions["postProcess"]> {
  return (text, settings, signal) => postProcessTranscript(
    text, settings.postProcessing, ctx.modelRegistry, signal,
    { onWarning: (message) => ctx.ui.notify(message, "warning") },
  );
}
