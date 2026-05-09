import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";

import { main } from "../src/cli";

const execFileAsync = promisify(execFile);

test("dashboard command renders the dashboard for --root", async () => {
  await withGitRepo(async (root) => {
    await writeDashboardFixture(root);

    const result = await captureMain(["dashboard", "--root", root]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Crack Dashboard/);
    assert.match(result.stdout, new RegExp(`Repo: ${escapeRegExp(root)}`));
    assert.match(result.stdout, /Inbox: 1 request/);
    assert.match(result.stdout, /- CLI Dashboard/);
    assert.match(result.stdout, /Branch: codex\/cli-dashboard/);
    assert.match(result.stdout, /Progress: 1\/2 completed/);
    assert.match(result.stdout, /Suggested command: crack run-all --plan \.crack\/plans\/demo\/plan\.md/);
  });
});

test("dashboard command is listed in CLI help", async () => {
  const result = await captureMain(["dashboard", "--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dashboard \[--root <path>\]/);
  assert.match(result.stdout, /\[--watch\] \[--interval <seconds>\]/);
});

test("dashboard watch rejects invalid intervals", async () => {
  const result = await captureMain(["dashboard", "--watch", "--interval", "-1"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--interval must be a positive number of seconds/);
});

test("dashboard interval requires watch mode", async () => {
  const result = await captureMain(["dashboard", "--interval", "1"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--interval can only be used with --watch/);
});

async function withGitRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "crack-cli-"));

  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeDashboardFixture(root: string): Promise<void> {
  const planDir = path.join(root, ".crack", "plans", "demo");
  await mkdir(planDir, { recursive: true });
  await writeFile(
    path.join(root, ".crack", "inbox.md"),
    [
      "# Inbox",
      "",
      "## Queued Request",
      "",
      "Received: 2026-05-09 12:00",
      "",
      "User prompt:",
      "",
      "> Follow up",
      "",
      "Reason:",
      "",
      "PR lock.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(planDir, "plan.md"),
    [
      "# Plan: CLI Dashboard",
      "",
      "Branch: codex/cli-dashboard",
      "",
      "## Commit Units",
      "",
      "### Commit 1: Build snapshot",
      "",
      "Read state.",
      "",
      "### Commit 2: Wire CLI",
      "",
      "Expose dashboard.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(planDir, "log.md"),
    ["# Log", "", "## 2026-05-09 12:10", "", "- Completed commit unit 1.", ""].join("\n"),
    "utf8",
  );
}

async function captureMain(argv: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };

  try {
    const status = await main(argv);
    return {
      status,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
