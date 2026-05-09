export const CODEX_CLI_MODEL = "gpt-5.5";
export const CODEX_CLI_REASONING_EFFORT = "xhigh";
export const CODEX_CLI_SERVICE_TIER = "fast";

export function codexCliDefaultArgs(): string[] {
  return [
    "--model",
    CODEX_CLI_MODEL,
    "--config",
    `model_reasoning_effort="${CODEX_CLI_REASONING_EFFORT}"`,
    "--config",
    `service_tier="${CODEX_CLI_SERVICE_TIER}"`,
    "--config",
    "features.fast_mode=true",
  ];
}

export function withCodexCliDefaults(extraArgs: string[] = []): string[] {
  return [...extraArgs, ...codexCliDefaultArgs()];
}
