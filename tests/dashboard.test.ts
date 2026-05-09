import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DASHBOARD_CLEAR_SCREEN,
  DEFAULT_DASHBOARD_WATCH_INTERVAL_SECONDS,
  parseDashboardWatchInterval,
  readDashboardSnapshot,
  refreshDashboard,
  renderDashboard,
} from "../src/dashboard";
import type { DashboardSnapshot, GitStatusReader } from "../src/dashboard";
import { parseGitStatus } from "../src/git";
import type { GitStatusSnapshot } from "../src/git";
import { MarkdownState } from "../src/state";

test("readDashboardSnapshot summarizes plans, queues, PR lock, and git status", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const planDir = path.join(root, ".crack", "plans", "demo");
    const planPath = path.join(planDir, "plan.md");
    await mkdir(planDir, { recursive: true });
    await writeFile(
      state.inboxPath,
      [
        "# Inbox",
        "",
        queuedRequest("First inbox request", "PR lock.", "2026-05-09 12:00"),
        queuedRequest("Second inbox request", "PR lock.", "2026-05-09 12:05"),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      state.prLockPath,
      [
        "# PR Lock",
        "",
        "Branch: codex/demo",
        "PR: https://github.com/example/repo/pull/7",
        "Status: reviewing",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      planPath,
      [
        "# Plan: Demo Dashboard",
        "",
        "Branch: codex/demo",
        "",
        "## Commit Units",
        "",
        "### Commit 1: Add snapshot model",
        "",
        "Create the model.",
        "",
        "### Commit 2: Render dashboard",
        "",
        "Render it.",
        "",
        "### Commit 3: Wire CLI",
        "",
        "Expose the command.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(planDir, "queue.md"),
      ["# Queue", "", queuedRequest("Follow-up request", "Depends on this plan.", "2026-05-09 12:10")].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(planDir, "log.md"),
      [
        "# Log",
        "",
        "## 2026-05-09 12:20",
        "",
        "- Started commit unit 1: Add snapshot model.",
        "- Completed commit unit 1.",
        "",
      ].join("\n"),
      "utf8",
    );

    const snapshot = await readDashboardSnapshot(state, {
      gitStatusReader: new StubGitStatusReader(parseGitStatus([
        "M  src/index.ts",
        " M src/dashboard.ts",
        "?? tests/dashboard.test.ts",
        "",
      ].join("\n"))),
    });

    assert.equal(snapshot.initialized, true);
    assert.equal(snapshot.inbox.count, 2);
    assert.equal(snapshot.prLock?.valid, true);
    assert.equal(snapshot.prLock?.branchName, "codex/demo");
    assert.equal(snapshot.prLock?.prUrl, "https://github.com/example/repo/pull/7");
    assert.equal(snapshot.prLock?.status, "reviewing");

    assert.equal(snapshot.plans.length, 1);
    const plan = snapshot.plans[0];
    assert.equal(plan.title, "Demo Dashboard");
    assert.equal(plan.branchName, "codex/demo");
    assert.equal(plan.relativePlanPath, ".crack/plans/demo/plan.md");
    assert.deepEqual(plan.commitUnits, {
      total: 3,
      completed: 1,
      remaining: 2,
      completedNumbers: [1],
      next: {
        number: 2,
        title: "Render dashboard",
      },
    });
    assert.equal(plan.queuedRequestCount, 1);
    assert.equal(
      plan.nextCommands.find((command) => command.kind === "run-all")?.command,
      "crack run-all --plan .crack/plans/demo/plan.md",
    );

    assert.equal(snapshot.git.isDirty, true);
    assert.equal(snapshot.git.changedFileCount, 3);
    assert.equal(snapshot.git.stagedFileCount, 1);
    assert.equal(snapshot.git.unstagedFileCount, 1);
    assert.equal(snapshot.git.untrackedFileCount, 1);
  });
});

test("readDashboardSnapshot does not initialize missing crack state", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);

    const snapshot = await readDashboardSnapshot(state, {
      gitStatusReader: new StubGitStatusReader(parseGitStatus("")),
    });

    assert.equal(snapshot.initialized, false);
    assert.equal(snapshot.inbox.count, 0);
    assert.equal(snapshot.prLock, null);
    assert.deepEqual(snapshot.plans, []);
    assert.equal(existsSync(state.crackDir), false);
  });
});

test("renderDashboard renders a compact summary with suggested run-all command", () => {
  const output = renderDashboard(sampleDashboardSnapshot());

  assert.match(output, /Crack Dashboard/);
  assert.match(output, /Repo: \/repo\/demo/);
  assert.match(output, /PR lock: active - branch codex\/demo, status reviewing, https:\/\/github\.com\/example\/repo\/pull\/7/);
  assert.match(output, /Inbox: 2 requests/);
  assert.match(output, /Dirty files: 3 \(staged 1, unstaged 1, untracked 1\)/);
  assert.match(output, /Plans:/);
  assert.match(output, /- Demo Dashboard/);
  assert.match(output, /Progress: 1\/3 completed/);
  assert.match(output, /Next: Commit 2 - Render dashboard/);
  assert.match(output, /Queued requests: 1 request/);
  assert.match(output, /Suggested command: crack run-all --plan \.crack\/plans\/demo\/plan\.md/);
  assert.match(output, /Recent activity:/);
  assert.match(output, /\[2026-05-09 12:20\] Completed commit unit 1\./);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("renderDashboard shows clear empty states", () => {
  const uninitialized = renderDashboard(sampleDashboardSnapshot({
    initialized: false,
    plans: [],
  }));
  assert.match(uninitialized, /State: \.crack not initialized/);
  assert.match(uninitialized, /No active plans because \.crack is not initialized\./);
  assert.match(uninitialized, /No recent activity\./);

  const initialized = renderDashboard(sampleDashboardSnapshot({
    initialized: true,
    plans: [],
  }));
  assert.match(initialized, /State: initialized/);
  assert.match(initialized, /No active plans\./);
});

test("parseDashboardWatchInterval accepts only positive seconds", () => {
  assert.equal(parseDashboardWatchInterval(undefined), DEFAULT_DASHBOARD_WATCH_INTERVAL_SECONDS);
  assert.equal(parseDashboardWatchInterval("5"), 5);
  assert.equal(parseDashboardWatchInterval("0.5"), 0.5);

  assert.throws(() => parseDashboardWatchInterval(true), /--interval requires a positive number of seconds/);
  assert.throws(() => parseDashboardWatchInterval("0"), /--interval must be a positive number of seconds/);
  assert.throws(() => parseDashboardWatchInterval("-1"), /--interval must be a positive number of seconds/);
  assert.throws(() => parseDashboardWatchInterval("abc"), /--interval must be a positive number of seconds/);
});

test("refreshDashboard writes one cleared dashboard render", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const writes: string[] = [];

    const output = await refreshDashboard(state, (value) => writes.push(value), {
      gitStatusReader: new StubGitStatusReader(parseGitStatus("")),
    });

    assert.deepEqual(writes, [output]);
    assert.ok(output.startsWith(DASHBOARD_CLEAR_SCREEN));
    assert.match(output, /Crack Dashboard/);
    assert.match(output, /State: \.crack not initialized/);
  });
});

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "crack-"));

  try {
    await mkdir(path.join(root, ".git"));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function queuedRequest(prompt: string, reason: string, receivedAt: string): string {
  return [
    "## Queued Request",
    "",
    `Received: ${receivedAt}`,
    "",
    "User prompt:",
    "",
    `> ${prompt}`,
    "",
    "Reason:",
    "",
    reason,
    "",
  ].join("\n");
}

class StubGitStatusReader implements GitStatusReader {
  constructor(private readonly snapshot: GitStatusSnapshot) {}

  async status(): Promise<GitStatusSnapshot> {
    return this.snapshot;
  }
}

function sampleDashboardSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    repoRoot: "/repo/demo",
    crackDir: "/repo/demo/.crack",
    initialized: true,
    inbox: {
      path: "/repo/demo/.crack/inbox.md",
      count: 2,
      requests: [],
    },
    prLock: {
      path: "/repo/demo/.crack/pr-lock.md",
      raw: "",
      valid: true,
      branchName: "codex/demo",
      prUrl: "https://github.com/example/repo/pull/7",
      status: "reviewing",
    },
    plans: [
      {
        directory: "/repo/demo/.crack/plans/demo",
        planPath: "/repo/demo/.crack/plans/demo/plan.md",
        queuePath: "/repo/demo/.crack/plans/demo/queue.md",
        logPath: "/repo/demo/.crack/plans/demo/log.md",
        relativeDirectory: ".crack/plans/demo",
        relativePlanPath: ".crack/plans/demo/plan.md",
        branchName: "codex/demo",
        title: "Demo Dashboard",
        commitUnits: {
          total: 3,
          completed: 1,
          remaining: 2,
          completedNumbers: [1],
          next: {
            number: 2,
            title: "Render dashboard",
          },
        },
        queuedRequestCount: 1,
        recentLogEntries: [
          {
            loggedAt: "2026-05-09 12:15",
            text: "Started commit unit 1.",
          },
          {
            loggedAt: "2026-05-09 12:20",
            text: "Completed commit unit 1.",
          },
        ],
        nextCommands: [
          {
            kind: "run-next",
            command: "crack run-next --plan .crack/plans/demo/plan.md",
          },
          {
            kind: "run-all",
            command: "crack run-all --plan .crack/plans/demo/plan.md",
          },
        ],
      },
    ],
    git: {
      raw: "",
      entries: [],
      isDirty: true,
      changedFileCount: 3,
      stagedFileCount: 1,
      unstagedFileCount: 1,
      untrackedFileCount: 1,
    },
    ...overrides,
  };
}
