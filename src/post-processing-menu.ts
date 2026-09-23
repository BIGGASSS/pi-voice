import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_POST_PROCESSING_PROMPT,
  type PostProcessingSettings,
} from "./post-processing-settings.js";
import type { TranscribeSettings } from "./settings.js";
import { SingleSelectPicker, type SingleSelectChoice } from "./ui-components.js";

type PostProcessingAction = "toggle" | "model" | "prompt" | "reset-prompt";
type CorrectionModel = NonNullable<PostProcessingSettings["model"]>;

type SavePostProcessing = (
  updated: PostProcessingSettings,
  successMessage: string,
) => Promise<boolean>;

const PRIVACY_NOTICE =
  "When enabled, transcript text is sent to the chosen provider and may cost money. This does not change the main session model.";

function modelLabel(model: CorrectionModel): string {
  return `${model.provider}/${model.id}`;
}

function modelKey(model: CorrectionModel): string {
  return JSON.stringify([model.provider, model.id]);
}

export function postProcessingSummary(settings: PostProcessingSettings): string {
  const state = settings.enabled ? "On" : "Off";
  return settings.model ? `${state} · ${modelLabel(settings.model)}` : state;
}

async function chooseCorrectionModel(
  ctx: ExtensionContext,
  current: CorrectionModel | undefined,
): Promise<CorrectionModel | undefined> {
  const models = [...ctx.modelRegistry.getAvailable()].sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
  if (models.length === 0) {
    ctx.ui.notify(
      "No LLMs available for post-processing. Configure a provider in Pi (for example with /login), then try again.",
      "warning",
    );
    return undefined;
  }
  const choices: SingleSelectChoice<string>[] = models.map((model) => ({
    value: modelKey(model),
    label: modelLabel(model),
    description: model.name,
  }));
  const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
    new SingleSelectPicker(
      tui,
      theme,
      keybindings,
      choices,
      current ? modelKey(current) : undefined,
      {
        title: "Choose post-processing LLM",
        subtitle: PRIVACY_NOTICE,
        searchable: true,
        cancelLabel: "back",
      },
      done,
    ),
  );
  const model = models.find((candidate) => modelKey(candidate) === selected);
  return model ? { provider: model.provider, id: model.id } : undefined;
}

async function confirmProviderCall(
  ctx: ExtensionContext,
  model: CorrectionModel,
): Promise<boolean> {
  return ctx.ui.confirm(
    "Enable transcript correction?",
    `Dictation transcripts will be sent to ${modelLabel(model)} for correction. This may cost money. Audio transcription remains local, and the main session model is unchanged.`,
  );
}

/** Save each completed action immediately using the settings menu's commit pattern. */
export async function showPostProcessingMenu(
  ctx: ExtensionContext,
  configured: TranscribeSettings,
  save: SavePostProcessing,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Post-processing settings require the interactive TUI", "error");
    return;
  }

  while (true) {
    const current = configured.postProcessing;
    const choices: SingleSelectChoice<PostProcessingAction>[] = [
      {
        value: "toggle",
        label: current.enabled ? "Disable post-processing" : "Enable post-processing",
        description: current.enabled
          ? "Use the local ASR transcript without LLM correction"
          : "Requires a chosen LLM; sends transcripts to its provider and may cost money",
      },
      {
        value: "model",
        label: `Model: ${current.model ? modelLabel(current.model) : "not selected"}`,
        description: "Choose a specific available LLM, independent of the main session model",
      },
      {
        value: "prompt",
        label: "Edit correction prompt",
        description: "Edit the full prompt sent with each transcript",
      },
      {
        value: "reset-prompt",
        label: "Reset correction prompt",
        description: "Restore conservative ASR typo and punctuation correction",
      },
    ];
    const action = await ctx.ui.custom<PostProcessingAction | undefined>(
      (tui, theme, keybindings, done) => new SingleSelectPicker(
        tui,
        theme,
        keybindings,
        choices,
        undefined,
        {
          title: "Post-processing",
          subtitle: `${postProcessingSummary(current)}\n${PRIVACY_NOTICE}`,
          cancelLabel: "back",
        },
        done,
      ),
    );
    if (!action) return;

    if (action === "toggle") {
      if (current.enabled) {
        await save({ ...current, enabled: false }, "Post-processing disabled");
        continue;
      }
      // A cancelled picker or confirmation never commits a partially enabled state.
      const model = current.model ?? (await chooseCorrectionModel(ctx, undefined));
      if (!model) continue;
      const available = ctx.modelRegistry.getAvailable().some(
        (candidate) => modelKey(candidate) === modelKey(model),
      );
      if (!available) {
        ctx.ui.notify(
          "The chosen LLM is unavailable. Choose an available post-processing model first.",
          "warning",
        );
        continue;
      }
      if (!(await confirmProviderCall(ctx, model))) continue;
      await save({ ...current, model, enabled: true }, "Post-processing enabled");
      continue;
    }

    if (action === "model") {
      const model = await chooseCorrectionModel(ctx, current.model);
      if (!model || (current.model && modelKey(model) === modelKey(current.model))) continue;
      if (current.enabled && !(await confirmProviderCall(ctx, model))) continue;
      await save({ ...current, model }, "Post-processing model saved (main session model unchanged)");
      continue;
    }

    if (action === "prompt") {
      const prompt = await ctx.ui.editor("Edit post-processing correction prompt", current.prompt);
      if (prompt === undefined || prompt === current.prompt) continue;
      if (!prompt.trim()) {
        ctx.ui.notify(
          "The correction prompt cannot be empty. Use Reset correction prompt to restore the default.",
          "warning",
        );
        continue;
      }
      await save({ ...current, prompt }, "Correction prompt saved");
      continue;
    }

    if (action === "reset-prompt" && current.prompt !== DEFAULT_POST_PROCESSING_PROMPT) {
      const confirmed = await ctx.ui.confirm(
        "Reset correction prompt?",
        "Replace the custom prompt with the default conservative ASR correction prompt?",
      );
      if (!confirmed) continue;
      await save({ ...current, prompt: DEFAULT_POST_PROCESSING_PROMPT }, "Correction prompt reset");
    }
  }
}
