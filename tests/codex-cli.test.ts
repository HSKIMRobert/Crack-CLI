import { stat } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_CLI_MODEL,
  CODEX_CLI_REASONING_EFFORT,
  CODEX_CLI_SERVICE_TIER,
  codexCliDefaultArgs,
  withCodexCliDefaults,
} from "../src/codex-cli";

test("codex CLI defaults force GPT-5.5, xhigh reasoning, and fast mode", () => {
  assert.equal(CODEX_CLI_MODEL, "gpt-5.5");
  assert.equal(CODEX_CLI_REASONING_EFFORT, "xhigh");
  assert.equal(CODEX_CLI_SERVICE_TIER, "fast");
  assert.deepEqual(codexCliDefaultArgs(), [
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'service_tier="fast"',
    "--config",
    "features.fast_mode=true",
  ]);
});

test("codex CLI defaults are appended after caller args", () => {
  assert.deepEqual(withCodexCliDefaults(["--model", "gpt-5.4-mini"]), [
    "--model",
    "gpt-5.4-mini",
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'service_tier="fast"',
    "--config",
    "features.fast_mode=true",
  ]);
});

test("built CLI file is executable", async () => {
  const mode = (await stat("dist/src/cli.js")).mode;

  assert.notEqual(mode & 0o111, 0);
});
