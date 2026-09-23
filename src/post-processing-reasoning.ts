export const POST_PROCESSING_REASONING_LEVELS = [
  "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

export type PostProcessingReasoningLevel = typeof POST_PROCESSING_REASONING_LEVELS[number];

type ReasoningModel = {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<"off" | PostProcessingReasoningLevel, string | null>>;
};

export function isPostProcessingReasoningLevel(value: unknown): value is PostProcessingReasoningLevel {
  return POST_PROCESSING_REASONING_LEVELS.some((level) => level === value);
}

/** Follow Pi's model metadata: null disables a level; extended levels require an explicit mapping. */
export function supportedPostProcessingReasoningLevels(model: ReasoningModel): PostProcessingReasoningLevel[] {
  if (!model.reasoning) return [];
  return POST_PROCESSING_REASONING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
