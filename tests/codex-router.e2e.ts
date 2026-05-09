import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import assert from "node:assert/strict";

import { CodexRouterAgent } from "../src/router-agent";

const execFileAsync = promisify(execFile);
const runCodexE2E = process.env.CRACK_E2E_CODEX === "1";

test(
  "CodexRouterAgent calls the real codex CLI and returns a PR-lock decision",
  { skip: !runCodexE2E, timeout: 180_000 },
  async () => {
    await withGitRepo(async (repoRoot) => {
      const agent = new CodexRouterAgent();
      const decision = await agent.decide({
        repoRoot,
        prompt: "Start a separate follow-up feature while the current PR is still reviewing.",
        prLock: [
          "# PR Lock",
          "",
          "Branch: codex/current",
          "PR: https://github.com/example/repo/pull/7",
          "Status: reviewing",
          "",
          "While this file exists, new requests are appended to inbox.md.",
        ].join("\n"),
        activePlans: [],
      });

      assert.equal(decision.action, "pause_for_pr_review");
      assert.match(decision.reason, /\S/);
    });
  },
);

async function withGitRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "crack-codex-e2e-"));

  try {
    await mkdir(path.join(repoRoot, "docs"));
    await writeFile(path.join(repoRoot, "README.md"), "# Codex E2E\n", "utf8");
    await writeFile(path.join(repoRoot, "docs", "workflow-design.md"), "# Workflow Design\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}
