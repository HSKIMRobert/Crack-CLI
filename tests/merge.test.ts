import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGitStatus } from "../src/git";
import type { GitStatusSnapshot } from "../src/git";
import { MergeRunner } from "../src/merge";
import type {
  GitCommandResult,
  LocalMergeGit,
  MergePullRequest,
  PullRequestMergeInput,
  PullRequestMergeTarget,
  PullRequestMerger,
  RemoteMergeGit,
} from "../src/merge";
import type { MergeAgent, MergeAgentInput, MergeAgentResult } from "../src/merge-agent";
import { MarkdownState } from "../src/state";

test("mergeLocal merges a completed plan branch into main", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    const agent = new StubMergeAgent({ status: "ready", summary: "unused" });
    const git = new StubLocalMergeGit({
      statuses: [parseGitStatus("")],
      mergeResult: gitResult({ stdout: "Updating abc..def\nFast-forward\n" }),
    });

    const result = await new MergeRunner(state, agent, git).mergeLocal({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.equal(result.action, "merged_local");
    assert.equal(result.sourceBranch, "codex/current");
    assert.equal(result.targetBranch, "main");
    assert.deepEqual(git.calls, ["status", "switch main", "merge codex/current"]);
    assert.equal(agent.inputs.length, 0);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Merged local branch `codex\/current` into `main`\./);
  });
});

test("mergeLocal lets the merge agent resolve conflicts and commits the merge", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    const agent = new StubMergeAgent({
      status: "ready",
      summary: "Resolved conflicting implementation.",
    });
    const git = new StubLocalMergeGit({
      statuses: [
        parseGitStatus(""),
        parseGitStatus("UU src/merge.ts\n"),
      ],
      mergeResult: gitResult({ status: 1, stderr: "CONFLICT (content): Merge conflict in src/merge.ts\n" }),
      unmergedPathBatches: [["src/merge.ts"], []],
      pendingMergeCommit: true,
    });

    const result = await new MergeRunner(state, agent, git).mergeLocal({
      planPath: plan.plan,
      targetBranch: "release",
      receivedAt: "2026-05-09 14:00",
    });

    assert.equal(result.action, "merged_local");
    assert.equal(result.targetBranch, "release");
    assert.deepEqual(git.calls, [
      "status",
      "switch release",
      "merge codex/current",
      "unmerged",
      "status",
      "unmerged",
      "has pending merge commit",
      "commit --no-edit",
    ]);
    assert.equal(agent.inputs.length, 1);
    assert.equal(agent.inputs[0].sourceBranch, "codex/current");
    assert.equal(agent.inputs[0].targetBranch, "release");
    assert.match(agent.inputs[0].gitStatus, /UU src\/merge\.ts/);
    assert.match(agent.inputs[0].failedMergeCommand, /git merge codex\/current/);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Merge agent summary: Resolved conflicting implementation\./);
    assert.match(log, /Merged local branch `codex\/current` into `release` after conflict resolution\./);
  });
});

test("mergeLocal stops when the merge agent cannot resolve conflicts", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    const agent = new StubMergeAgent({
      status: "needs_work",
      reason: "Manual decision needed.",
    });
    const git = new StubLocalMergeGit({
      statuses: [
        parseGitStatus(""),
        parseGitStatus("UU src/merge.ts\n"),
      ],
      mergeResult: gitResult({ status: 1, stderr: "CONFLICT (content): Merge conflict in src/merge.ts\n" }),
      unmergedPathBatches: [["src/merge.ts"]],
      pendingMergeCommit: true,
    });

    const result = await new MergeRunner(state, agent, git).mergeLocal({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.deepEqual(result, {
      action: "needs_work",
      planPath: plan.plan,
      sourceBranch: "codex/current",
      targetBranch: "main",
      reason: "Merge agent needs work: Manual decision needed.",
    });
    assert.deepEqual(git.calls, [
      "status",
      "switch main",
      "merge codex/current",
      "unmerged",
      "status",
    ]);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Local merge needs work: Merge agent needs work: Manual decision needed\./);
  });
});

test("mergeLocal refuses to merge an incomplete plan", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state, [1]);
    const agent = new StubMergeAgent({ status: "ready", summary: "unused" });
    const git = new StubLocalMergeGit({ statuses: [parseGitStatus("")] });

    const result = await new MergeRunner(state, agent, git).mergeLocal({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.deepEqual(result, {
      action: "needs_work",
      planPath: plan.plan,
      sourceBranch: "codex/current",
      targetBranch: "main",
      reason: "Commit units not complete: 2.",
    });
    assert.deepEqual(git.calls, []);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Local merge needs work: Commit units not complete: 2\./);
  });
});

test("mergeLocal refuses to merge with a dirty working tree", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    const agent = new StubMergeAgent({ status: "ready", summary: "unused" });
    const git = new StubLocalMergeGit({
      statuses: [parseGitStatus(" M src/cli.ts\n?? scratch.txt\n")],
    });

    const result = await new MergeRunner(state, agent, git).mergeLocal({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.equal(result.action, "needs_work");
    assert.match(result.reason, /Working tree is not clean: src\/cli\.ts, scratch\.txt\./);
    assert.deepEqual(git.calls, ["status"]);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Local merge needs work: Working tree is not clean: src\/cli\.ts, scratch\.txt\./);
  });
});

test("mergeRemote pushes the branch, merges a ready PR, and clears a matching lock", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    await state.setPrLock({
      branchName: "codex/current",
      prUrl: "https://github.com/example/repo/pull/7",
      reason: "Reviewing.",
    });

    const agent = new StubMergeAgent({ status: "ready", summary: "unused" });
    const git = new StubRemoteMergeGit({
      statuses: [parseGitStatus("")],
    });
    const pullRequests = new StubPullRequestMerger({
      url: "https://github.com/example/repo/pull/7",
      title: "Current",
      reused: true,
    });

    const result = await new MergeRunner(state, agent, git, pullRequests).mergeRemote({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.equal(result.action, "merged_remote");
    assert.equal(result.sourceBranch, "codex/current");
    assert.equal(result.targetBranch, "main");
    assert.equal(result.prUrl, "https://github.com/example/repo/pull/7");
    assert.equal(result.lockCleared, true);
    assert.deepEqual(git.calls, ["status", "push codex/current"]);
    assert.deepEqual(pullRequests.calls, [
      "ensure codex/current main",
      "merge https://github.com/example/repo/pull/7",
    ]);
    assert.equal(agent.inputs.length, 0);
    assert.equal(await state.readPrLock(), null);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Merged remote PR https:\/\/github\.com\/example\/repo\/pull\/7 into `main`\./);
    assert.match(log, /Cleared PR lock for `codex\/current`\./);
  });
});

test("mergeRemote updates the source branch and lets the merge agent resolve remote conflicts", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    const agent = new StubMergeAgent({
      status: "ready",
      summary: "Resolved remote conflict.",
    });
    const git = new StubRemoteMergeGit({
      statuses: [
        parseGitStatus(""),
        parseGitStatus("UU src/merge.ts\n"),
      ],
      mergeResults: [
        gitResult({ status: 1, stderr: "CONFLICT (content): Merge conflict in src/merge.ts\n" }),
      ],
      unmergedPathBatches: [["src/merge.ts"], []],
      pendingMergeCommit: true,
    });
    const pullRequests = new StubPullRequestMerger(
      {
        url: "https://github.com/example/repo/pull/8",
        title: "Current",
        reused: false,
      },
      [
        gitResult({
          status: 1,
          stderr: "Pull request is not mergeable: base branch was modified and has conflicts.\n",
        }),
        gitResult(),
      ],
    );

    const result = await new MergeRunner(state, agent, git, pullRequests).mergeRemote({
      planPath: plan.plan,
      targetBranch: "release",
      receivedAt: "2026-05-09 14:00",
    });

    assert.equal(result.action, "merged_remote");
    assert.equal(result.targetBranch, "release");
    assert.equal(result.lockCleared, false);
    assert.deepEqual(git.calls, [
      "status",
      "push codex/current",
      "fetch release",
      "switch codex/current",
      "merge origin/release",
      "unmerged",
      "status",
      "unmerged",
      "has pending merge commit",
      "commit --no-edit",
      "push codex/current",
    ]);
    assert.deepEqual(pullRequests.calls, [
      "ensure codex/current release",
      "merge https://github.com/example/repo/pull/8",
      "merge https://github.com/example/repo/pull/8",
    ]);
    assert.equal(agent.inputs.length, 1);
    assert.equal(agent.inputs[0].mergeMode, "remote");
    assert.equal(agent.inputs[0].sourceBranch, "codex/current");
    assert.equal(agent.inputs[0].targetBranch, "release");
    assert.match(agent.inputs[0].failedMergeCommand, /git merge origin\/release/);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Merge agent summary: Resolved remote conflict\./);
    assert.match(log, /Merged remote PR https:\/\/github\.com\/example\/repo\/pull\/8 into `release`\./);
  });
});

test("mergeRemote keeps the PR lock when the PR merge fails", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await createCompletedPlan(state);
    await state.setPrLock({
      branchName: "codex/current",
      prUrl: "https://github.com/example/repo/pull/7",
      reason: "Reviewing.",
    });

    const agent = new StubMergeAgent({ status: "ready", summary: "unused" });
    const git = new StubRemoteMergeGit({
      statuses: [parseGitStatus("")],
    });
    const pullRequests = new StubPullRequestMerger(
      {
        url: "https://github.com/example/repo/pull/7",
        title: "Current",
        reused: true,
      },
      [gitResult({ status: 1, stderr: "Required status check is pending.\n" })],
    );

    const result = await new MergeRunner(state, agent, git, pullRequests).mergeRemote({
      planPath: plan.plan,
      receivedAt: "2026-05-09 14:00",
    });

    assert.deepEqual(result, {
      action: "needs_work",
      planPath: plan.plan,
      sourceBranch: "codex/current",
      targetBranch: "main",
      reason: "Failed to merge remote PR: Required status check is pending.",
    });
    assert.notEqual(await state.readPrLock(), null);
    assert.deepEqual(git.calls, ["status", "push codex/current"]);
    assert.deepEqual(pullRequests.calls, [
      "ensure codex/current main",
      "merge https://github.com/example/repo/pull/7",
    ]);

    const log = await readFile(plan.log, "utf8");
    assert.match(log, /Remote merge needs work: Failed to merge remote PR: Required status check is pending\./);
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

async function createCompletedPlan(state: MarkdownState, completedUnits = [1, 2]) {
  const plan = await state.createPlan({
    branchName: "codex/current",
    planTitle: "Current",
    prompt: "Initial request",
    reason: "test setup",
    receivedAt: "2026-05-09 12:00",
  });

  await writeFile(
    plan.plan,
    [
      "# Plan: Current",
      "",
      "Branch: codex/current",
      "",
      "## Commit Units",
      "",
      "### Commit 1: Add model",
      "",
      "Create the model.",
      "",
      "### Commit 2: Wire command",
      "",
      "Add the command.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    plan.log,
    [
      "# Log",
      "",
      ...completedUnits.map((unit) => `- Completed commit unit ${unit}.`),
      "",
    ].join("\n"),
    "utf8",
  );

  return plan;
}

class StubMergeAgent implements MergeAgent {
  readonly inputs: MergeAgentInput[] = [];

  constructor(private readonly result: MergeAgentResult) {}

  async resolveConflicts(input: MergeAgentInput): Promise<MergeAgentResult> {
    this.inputs.push(input);
    return this.result;
  }
}

class StubLocalMergeGit implements LocalMergeGit {
  readonly calls: string[] = [];
  private readonly statuses: GitStatusSnapshot[];
  private readonly unmergedPathBatches: string[][];
  private readonly switchResult: GitCommandResult;
  private readonly mergeResults: GitCommandResult[];
  private readonly commitResult: GitCommandResult;
  private readonly pendingMergeCommit: boolean;
  private lastStatus: GitStatusSnapshot;

  constructor(options: {
    statuses?: GitStatusSnapshot[];
    unmergedPathBatches?: string[][];
    switchResult?: GitCommandResult;
    mergeResult?: GitCommandResult;
    mergeResults?: GitCommandResult[];
    commitResult?: GitCommandResult;
    pendingMergeCommit?: boolean;
  }) {
    this.statuses = [...(options.statuses ?? [parseGitStatus("")])];
    this.unmergedPathBatches = [...(options.unmergedPathBatches ?? [])];
    this.switchResult = options.switchResult ?? gitResult();
    this.mergeResults = [...(options.mergeResults ?? [options.mergeResult ?? gitResult()])];
    this.commitResult = options.commitResult ?? gitResult();
    this.pendingMergeCommit = options.pendingMergeCommit ?? false;
    this.lastStatus = this.statuses[this.statuses.length - 1] ?? parseGitStatus("");
  }

  async status(): Promise<GitStatusSnapshot> {
    this.calls.push("status");
    const nextStatus = this.statuses.shift();
    if (nextStatus) {
      this.lastStatus = nextStatus;
    }

    return this.lastStatus;
  }

  async switchBranch(branchName: string): Promise<GitCommandResult> {
    this.calls.push(`switch ${branchName}`);
    return { ...this.switchResult, command: `git switch ${branchName}` };
  }

  async mergeBranch(branchName: string): Promise<GitCommandResult> {
    this.calls.push(`merge ${branchName}`);
    const result = this.mergeResults.shift() ?? gitResult();
    return { ...result, command: `git merge ${branchName}` };
  }

  async unmergedPaths(): Promise<string[]> {
    this.calls.push("unmerged");
    return this.unmergedPathBatches.shift() ?? [];
  }

  async hasPendingMergeCommit(): Promise<boolean> {
    this.calls.push("has pending merge commit");
    return this.pendingMergeCommit;
  }

  async commitMerge(): Promise<GitCommandResult> {
    this.calls.push("commit --no-edit");
    return { ...this.commitResult, command: "git commit --no-edit" };
  }
}

class StubRemoteMergeGit extends StubLocalMergeGit implements RemoteMergeGit {
  private readonly fetchResults: GitCommandResult[];
  private readonly pushResults: GitCommandResult[];

  constructor(options: ConstructorParameters<typeof StubLocalMergeGit>[0] & {
    fetchResults?: GitCommandResult[];
    pushResults?: GitCommandResult[];
  }) {
    super(options);
    this.fetchResults = [...(options.fetchResults ?? [gitResult()])];
    this.pushResults = [...(options.pushResults ?? [gitResult(), gitResult()])];
  }

  async fetchBranch(branchName: string): Promise<GitCommandResult> {
    this.calls.push(`fetch ${branchName}`);
    const result = this.fetchResults.shift() ?? gitResult();
    return { ...result, command: `git fetch origin ${branchName}` };
  }

  async pushBranch(branchName: string): Promise<GitCommandResult> {
    this.calls.push(`push ${branchName}`);
    const result = this.pushResults.shift() ?? gitResult();
    return { ...result, command: `git push -u origin ${branchName}` };
  }
}

class StubPullRequestMerger implements PullRequestMerger {
  readonly calls: string[] = [];
  readonly ensureInputs: PullRequestMergeInput[] = [];
  readonly mergeInputs: PullRequestMergeTarget[] = [];
  private readonly mergeResults: GitCommandResult[];

  constructor(
    private readonly pullRequest: MergePullRequest,
    mergeResults: GitCommandResult[] = [gitResult()],
  ) {
    this.mergeResults = [...mergeResults];
  }

  async ensureReady(input: PullRequestMergeInput): Promise<MergePullRequest> {
    this.calls.push(`ensure ${input.sourceBranch} ${input.targetBranch}`);
    this.ensureInputs.push(input);
    return this.pullRequest;
  }

  async merge(input: PullRequestMergeTarget): Promise<GitCommandResult> {
    this.calls.push(`merge ${input.prUrl}`);
    this.mergeInputs.push(input);
    const result = this.mergeResults.shift() ?? gitResult();
    return { ...result, command: `gh pr merge ${input.prUrl} --merge` };
  }
}

function gitResult(options: {
  status?: number;
  stdout?: string;
  stderr?: string;
  command?: string;
} = {}): GitCommandResult {
  return {
    status: options.status ?? 0,
    stdout: options.stdout ?? "",
    stderr: options.stderr ?? "",
    command: options.command ?? "git",
  };
}
