import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseGitStatus } from "./git";
import type { GitStatusSnapshot } from "./git";
import { CodexMergeAgent } from "./merge-agent";
import type { MergeAgent } from "./merge-agent";
import { branchNameFromPlan, checkPlanReady } from "./plan-readiness";
import { parsePrLock } from "./pr-check";
import { parsePullRequestUrl } from "./pr";
import { runProcess } from "./process";
import type { ProcessResult } from "./process";
import { MarkdownState } from "./state";
import type { PlanPaths } from "./state";

export type LocalMergeOptions = {
  planPath?: string;
  targetBranch?: string;
  receivedAt?: string;
};

export type LocalMergeResult =
  | {
      action: "merged_local";
      planPath: string;
      sourceBranch: string;
      targetBranch: string;
      summary: string;
    }
  | {
      action: "needs_work";
      planPath: string;
      sourceBranch?: string;
      targetBranch: string;
      reason: string;
    };

export type RemoteMergeOptions = LocalMergeOptions;

export type RemoteMergeResult =
  | {
      action: "merged_remote";
      planPath: string;
      sourceBranch: string;
      targetBranch: string;
      prUrl: string;
      summary: string;
      lockCleared: boolean;
    }
  | {
      action: "needs_work";
      planPath: string;
      sourceBranch?: string;
      targetBranch: string;
      reason: string;
    };

export type GitCommandResult = ProcessResult & {
  command: string;
};

export interface LocalMergeGit {
  status(): Promise<GitStatusSnapshot>;
  switchBranch(branchName: string): Promise<GitCommandResult>;
  mergeBranch(branchName: string): Promise<GitCommandResult>;
  unmergedPaths(): Promise<string[]>;
  hasPendingMergeCommit(): Promise<boolean>;
  commitMerge(): Promise<GitCommandResult>;
}

export interface RemoteMergeGit extends LocalMergeGit {
  fetchBranch(branchName: string): Promise<GitCommandResult>;
  pushBranch(branchName: string): Promise<GitCommandResult>;
}

export type PullRequestMergeInput = {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
};

export type PullRequestMergeTarget = {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  prUrl: string;
};

export type MergePullRequest = {
  url: string;
  title: string;
  reused: boolean;
};

export interface PullRequestMerger {
  ensureReady(input: PullRequestMergeInput): Promise<MergePullRequest>;
  merge(input: PullRequestMergeTarget): Promise<GitCommandResult>;
}

type SelectedPlan = {
  paths: PlanPaths;
  planContent: string;
  logContent: string;
};

type ConflictResolutionResult =
  | {
      status: "ready";
      agentSummary: string;
    }
  | {
      status: "needs_work";
      reason: string;
    };

type GhPullRequestListItem = {
  url?: unknown;
  title?: unknown;
  isDraft?: unknown;
};

type ExistingPullRequest = {
  url: string;
  title: string;
  isDraft: boolean;
};

export class GitCliLocalMergeGit implements RemoteMergeGit {
  constructor(private readonly repoRoot: string) {}

  async status(): Promise<GitStatusSnapshot> {
    const result = await this.runGit(["status", "--porcelain", "--untracked-files=all"]);
    if (result.status !== 0) {
      const details = commandOutput(result);
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to read git status${suffix}`);
    }

    return parseGitStatus(result.stdout);
  }

  async switchBranch(branchName: string): Promise<GitCommandResult> {
    return this.runGit(["switch", branchName]);
  }

  async mergeBranch(branchName: string): Promise<GitCommandResult> {
    return this.runGit(["merge", branchName]);
  }

  async unmergedPaths(): Promise<string[]> {
    const result = await this.runGit(["diff", "--name-only", "--diff-filter=U"]);
    if (result.status !== 0) {
      const details = commandOutput(result);
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to read unmerged paths${suffix}`);
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async hasPendingMergeCommit(): Promise<boolean> {
    const result = await this.runGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return result.status === 0;
  }

  async commitMerge(): Promise<GitCommandResult> {
    return this.runGit(["commit", "--no-edit"]);
  }

  async fetchBranch(branchName: string): Promise<GitCommandResult> {
    return this.runGit(["fetch", "origin", branchName]);
  }

  async pushBranch(branchName: string): Promise<GitCommandResult> {
    return this.runGit(["push", "-u", "origin", branchName]);
  }

  private async runGit(args: string[]): Promise<GitCommandResult> {
    const result = await runProcess("git", args, { cwd: this.repoRoot });
    return {
      ...result,
      command: ["git", ...args].join(" "),
    };
  }
}

export class GitHubCliPullRequestMerger implements PullRequestMerger {
  constructor(
    private readonly command = "gh",
    private readonly extraArgs: string[] = [],
  ) {}

  async ensureReady(input: PullRequestMergeInput): Promise<MergePullRequest> {
    const existingPullRequest = await this.findExistingPullRequest(input);
    if (existingPullRequest) {
      if (existingPullRequest.isDraft) {
        const readyResult = await this.runGh(["pr", "ready", existingPullRequest.url], input.repoRoot);
        if (readyResult.status !== 0) {
          throw new Error(commandFailureReason("Failed to mark existing PR ready", readyResult));
        }
      }

      return {
        url: existingPullRequest.url,
        title: existingPullRequest.title,
        reused: true,
      };
    }

    const createResult = await this.runGh(
      [
        "pr",
        "create",
        "--head",
        input.sourceBranch,
        "--base",
        input.targetBranch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      input.repoRoot,
    );
    if (createResult.status !== 0) {
      throw new Error(commandFailureReason("Failed to create ready PR", createResult));
    }

    const output = [createResult.stdout, createResult.stderr].join("\n");
    const url = parsePullRequestUrl(output);
    if (!url) {
      throw new Error(`Failed to read PR URL from gh output: ${output.trim()}`);
    }

    return {
      url,
      title: input.title,
      reused: false,
    };
  }

  async merge(input: PullRequestMergeTarget): Promise<GitCommandResult> {
    return this.runGh(["pr", "merge", input.prUrl, "--merge"], input.repoRoot);
  }

  private async findExistingPullRequest(input: PullRequestMergeInput): Promise<ExistingPullRequest | null> {
    const result = await this.runGh(
      [
        "pr",
        "list",
        "--head",
        input.sourceBranch,
        "--base",
        input.targetBranch,
        "--state",
        "open",
        "--json",
        "url,title,isDraft",
        "--limit",
        "1",
      ],
      input.repoRoot,
    );
    if (result.status !== 0) {
      throw new Error(commandFailureReason("Failed to find existing PR", result));
    }

    return parseExistingPullRequest(result.stdout);
  }

  private async runGh(args: string[], repoRoot: string): Promise<GitCommandResult> {
    const result = await runProcess(this.command, [...args, ...this.extraArgs], { cwd: repoRoot });

    return {
      ...result,
      command: [this.command, ...args].join(" "),
    };
  }
}

export class MergeRunner {
  private readonly state: MarkdownState;
  private readonly agent: MergeAgent;
  private readonly git: LocalMergeGit;
  private readonly pullRequests: PullRequestMerger;

  constructor(
    state: MarkdownState,
    agent: MergeAgent = new CodexMergeAgent(),
    git?: LocalMergeGit,
    pullRequests: PullRequestMerger = new GitHubCliPullRequestMerger(),
  ) {
    this.state = state;
    this.agent = agent;
    this.git = git ?? new GitCliLocalMergeGit(state.repoRoot);
    this.pullRequests = pullRequests;
  }

  async mergeLocal(options: LocalMergeOptions = {}): Promise<LocalMergeResult> {
    const selectedPlan = await this.selectPlan(options.planPath);
    const sourceBranch = branchNameFromPlan(selectedPlan.planContent);
    const targetBranch = options.targetBranch === undefined ? "main" : options.targetBranch.trim();

    const readiness = checkPlanReady(selectedPlan.planContent, selectedPlan.logContent);
    if (!readiness.ready) {
      return this.needsWork(selectedPlan, sourceBranch, targetBranch, readiness.reason, options.receivedAt);
    }

    if (!sourceBranch) {
      return this.needsWork(selectedPlan, sourceBranch, targetBranch, "Plan is missing a Branch line.", options.receivedAt);
    }

    if (!targetBranch) {
      return this.needsWork(selectedPlan, sourceBranch, targetBranch, "Target branch is required.", options.receivedAt);
    }

    const status = await this.git.status();
    if (status.entries.length > 0) {
      return this.needsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        `Working tree is not clean: ${status.entries.map((entry) => entry.path).join(", ")}.`,
        options.receivedAt,
      );
    }

    const switchResult = await this.git.switchBranch(targetBranch);
    if (switchResult.status !== 0) {
      return this.needsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        commandFailureReason(`Failed to switch to ${targetBranch}`, switchResult),
        options.receivedAt,
      );
    }

    const mergeResult = await this.git.mergeBranch(sourceBranch);
    if (mergeResult.status === 0) {
      const summary = `Merged local branch \`${sourceBranch}\` into \`${targetBranch}\`.`;
      await this.state.appendPlanLog(selectedPlan.paths, [summary], options.receivedAt);

      return {
        action: "merged_local",
        planPath: selectedPlan.paths.plan,
        sourceBranch,
        targetBranch,
        summary,
      };
    }

    const unmergedPaths = await this.git.unmergedPaths();
    if (unmergedPaths.length === 0) {
      return this.needsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        commandFailureReason(`Failed to merge ${sourceBranch}`, mergeResult),
        options.receivedAt,
      );
    }

    return this.resolveConflicts({
      selectedPlan,
      sourceBranch,
      targetBranch,
      mergeResult,
      receivedAt: options.receivedAt,
    });
  }

  async mergeRemote(options: RemoteMergeOptions = {}): Promise<RemoteMergeResult> {
    const selectedPlan = await this.selectPlan(options.planPath);
    const sourceBranch = branchNameFromPlan(selectedPlan.planContent);
    const targetBranch = options.targetBranch === undefined ? "main" : options.targetBranch.trim();

    const readiness = checkPlanReady(selectedPlan.planContent, selectedPlan.logContent);
    if (!readiness.ready) {
      return this.remoteNeedsWork(selectedPlan, sourceBranch, targetBranch, readiness.reason, options.receivedAt);
    }

    if (!sourceBranch) {
      return this.remoteNeedsWork(selectedPlan, sourceBranch, targetBranch, "Plan is missing a Branch line.", options.receivedAt);
    }

    if (!targetBranch) {
      return this.remoteNeedsWork(selectedPlan, sourceBranch, targetBranch, "Target branch is required.", options.receivedAt);
    }

    const remoteGit = asRemoteMergeGit(this.git);
    if (!remoteGit) {
      return this.remoteNeedsWork(selectedPlan, sourceBranch, targetBranch, "Remote git operations are not available.", options.receivedAt);
    }

    const status = await this.git.status();
    if (status.entries.length > 0) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        `Working tree is not clean: ${status.entries.map((entry) => entry.path).join(", ")}.`,
        options.receivedAt,
      );
    }

    const pushResult = await remoteGit.pushBranch(sourceBranch);
    if (pushResult.status !== 0) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        commandFailureReason(`Failed to push ${sourceBranch}`, pushResult),
        options.receivedAt,
      );
    }

    let pullRequest: MergePullRequest;
    try {
      pullRequest = await this.pullRequests.ensureReady({
        repoRoot: this.state.repoRoot,
        sourceBranch,
        targetBranch,
        title: pullRequestTitle(selectedPlan.planContent, sourceBranch),
        body: buildPullRequestBody({
          repoRoot: this.state.repoRoot,
          planPath: selectedPlan.paths.plan,
          sourceBranch,
          targetBranch,
        }),
      });
    } catch (error) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        errorMessage(error),
        options.receivedAt,
      );
    }

    let firstMergeResult: GitCommandResult;
    try {
      firstMergeResult = await this.pullRequests.merge({
        repoRoot: this.state.repoRoot,
        sourceBranch,
        targetBranch,
        prUrl: pullRequest.url,
      });
    } catch (error) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        errorMessage(error),
        options.receivedAt,
      );
    }
    if (firstMergeResult.status === 0) {
      return this.remoteSuccess(selectedPlan, sourceBranch, targetBranch, pullRequest.url, undefined, options.receivedAt);
    }

    if (!isRetryableRemoteMergeFailure(firstMergeResult)) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        commandFailureReason("Failed to merge remote PR", firstMergeResult),
        options.receivedAt,
      );
    }

    const updateResult = await this.updateSourceBranchFromTarget({
      remoteGit,
      selectedPlan,
      sourceBranch,
      targetBranch,
    });
    if (updateResult.status === "needs_work") {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        updateResult.reason,
        options.receivedAt,
      );
    }

    const retryPushResult = await remoteGit.pushBranch(sourceBranch);
    if (retryPushResult.status !== 0) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        commandFailureReason(`Failed to push ${sourceBranch} after updating from ${targetBranch}`, retryPushResult),
        options.receivedAt,
      );
    }

    let retryMergeResult: GitCommandResult;
    try {
      retryMergeResult = await this.pullRequests.merge({
        repoRoot: this.state.repoRoot,
        sourceBranch,
        targetBranch,
        prUrl: pullRequest.url,
      });
    } catch (error) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        errorMessage(error),
        options.receivedAt,
      );
    }
    if (retryMergeResult.status !== 0) {
      return this.remoteNeedsWork(
        selectedPlan,
        sourceBranch,
        targetBranch,
        commandFailureReason("Failed to merge remote PR after updating source branch", retryMergeResult),
        options.receivedAt,
      );
    }

    return this.remoteSuccess(
      selectedPlan,
      sourceBranch,
      targetBranch,
      pullRequest.url,
      updateResult.agentSummary,
      options.receivedAt,
    );
  }

  private async resolveConflicts(options: {
    selectedPlan: SelectedPlan;
    sourceBranch: string;
    targetBranch: string;
    mergeResult: GitCommandResult;
    receivedAt?: string;
  }): Promise<LocalMergeResult> {
    const resolution = await this.resolveConflictState({
      selectedPlan: options.selectedPlan,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      mergeMode: "local",
      mergeResult: options.mergeResult,
    });

    if (resolution.status === "needs_work") {
      return this.needsWork(
        options.selectedPlan,
        options.sourceBranch,
        options.targetBranch,
        resolution.reason,
        options.receivedAt,
      );
    }

    const summary = `Merged local branch \`${options.sourceBranch}\` into \`${options.targetBranch}\` after conflict resolution.`;
    await this.state.appendPlanLog(
      options.selectedPlan.paths,
      [
        `Merge agent summary: ${resolution.agentSummary}`,
        summary,
      ],
      options.receivedAt,
    );

    return {
      action: "merged_local",
      planPath: options.selectedPlan.paths.plan,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      summary,
    };
  }

  private async resolveConflictState(options: {
    selectedPlan: SelectedPlan;
    sourceBranch: string;
    targetBranch: string;
    mergeMode: "local" | "remote";
    mergeResult: GitCommandResult;
  }): Promise<ConflictResolutionResult> {
    const gitStatus = await this.git.status();
    const agentResult = await this.agent.resolveConflicts({
      repoRoot: this.state.repoRoot,
      planPath: options.selectedPlan.paths.plan,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      mergeMode: options.mergeMode,
      gitStatus: gitStatus.raw,
      failedMergeCommand: failedMergeCommandSummary(options.mergeResult),
    });

    if (agentResult.status === "needs_work") {
      return {
        status: "needs_work",
        reason: `Merge agent needs work: ${agentResult.reason}`,
      };
    }

    const remainingUnmergedPaths = await this.git.unmergedPaths();
    if (remainingUnmergedPaths.length > 0) {
      return {
        status: "needs_work",
        reason: `Unmerged paths remain after merge agent: ${remainingUnmergedPaths.join(", ")}.`,
      };
    }

    if (await this.git.hasPendingMergeCommit()) {
      const commitResult = await this.git.commitMerge();
      if (commitResult.status !== 0) {
        return {
          status: "needs_work",
          reason: commandFailureReason("Failed to commit resolved merge", commitResult),
        };
      }
    }

    return {
      status: "ready",
      agentSummary: agentResult.summary,
    };
  }

  private async updateSourceBranchFromTarget(options: {
    remoteGit: RemoteMergeGit;
    selectedPlan: SelectedPlan;
    sourceBranch: string;
    targetBranch: string;
  }): Promise<ConflictResolutionResult> {
    const fetchResult = await options.remoteGit.fetchBranch(options.targetBranch);
    if (fetchResult.status !== 0) {
      return {
        status: "needs_work",
        reason: commandFailureReason(`Failed to fetch origin/${options.targetBranch}`, fetchResult),
      };
    }

    const switchResult = await options.remoteGit.switchBranch(options.sourceBranch);
    if (switchResult.status !== 0) {
      return {
        status: "needs_work",
        reason: commandFailureReason(`Failed to switch to ${options.sourceBranch}`, switchResult),
      };
    }

    const mergeResult = await options.remoteGit.mergeBranch(`origin/${options.targetBranch}`);
    if (mergeResult.status === 0) {
      return {
        status: "ready",
        agentSummary: "",
      };
    }

    const unmergedPaths = await options.remoteGit.unmergedPaths();
    if (unmergedPaths.length === 0) {
      return {
        status: "needs_work",
        reason: commandFailureReason(`Failed to merge origin/${options.targetBranch}`, mergeResult),
      };
    }

    return this.resolveConflictState({
      selectedPlan: options.selectedPlan,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      mergeMode: "remote",
      mergeResult,
    });
  }

  private async remoteSuccess(
    selectedPlan: SelectedPlan,
    sourceBranch: string,
    targetBranch: string,
    prUrl: string,
    agentSummary?: string,
    receivedAt?: string,
  ): Promise<RemoteMergeResult> {
    const lockCleared = await this.clearMatchingPrLock(sourceBranch);
    const summary = `Merged remote PR ${prUrl} into \`${targetBranch}\`.`;
    const entries = [
      agentSummary ? `Merge agent summary: ${agentSummary}` : "",
      summary,
      lockCleared ? `Cleared PR lock for \`${sourceBranch}\`.` : "",
    ].filter(Boolean);

    await this.state.appendPlanLog(selectedPlan.paths, entries, receivedAt);

    return {
      action: "merged_remote",
      planPath: selectedPlan.paths.plan,
      sourceBranch,
      targetBranch,
      prUrl,
      summary,
      lockCleared,
    };
  }

  private async remoteNeedsWork(
    selectedPlan: SelectedPlan,
    sourceBranch: string | undefined,
    targetBranch: string,
    reason: string,
    receivedAt?: string,
  ): Promise<RemoteMergeResult> {
    await this.state.appendPlanLog(
      selectedPlan.paths,
      [`Remote merge needs work: ${reason}`],
      receivedAt,
    );

    return {
      action: "needs_work",
      planPath: selectedPlan.paths.plan,
      sourceBranch,
      targetBranch,
      reason,
    };
  }

  private async clearMatchingPrLock(sourceBranch: string): Promise<boolean> {
    const lockContent = await this.state.readPrLock();
    if (!lockContent) {
      return false;
    }

    const lock = parsePrLock(lockContent);
    if (lock?.branchName !== sourceBranch) {
      return false;
    }

    return this.state.clearPrLock();
  }

  private async needsWork(
    selectedPlan: SelectedPlan,
    sourceBranch: string | undefined,
    targetBranch: string,
    reason: string,
    receivedAt?: string,
  ): Promise<LocalMergeResult> {
    await this.state.appendPlanLog(
      selectedPlan.paths,
      [`Local merge needs work: ${reason}`],
      receivedAt,
    );

    return {
      action: "needs_work",
      planPath: selectedPlan.paths.plan,
      sourceBranch,
      targetBranch,
      reason,
    };
  }

  private async selectPlan(planPath?: string): Promise<SelectedPlan> {
    if (planPath) {
      const paths = this.state.existingPlanPaths(planPath);
      return readSelectedPlan(paths);
    }

    const activePlans = await this.state.listActivePlans();
    if (activePlans.length === 0) {
      throw new Error("No active plans found");
    }

    if (activePlans.length > 1) {
      throw new Error("Multiple active plans found; pass --plan <path>");
    }

    return readSelectedPlan(activePlans[0]);
  }
}

function asRemoteMergeGit(git: LocalMergeGit): RemoteMergeGit | null {
  const candidate = git as Partial<RemoteMergeGit>;

  if (typeof candidate.fetchBranch !== "function" || typeof candidate.pushBranch !== "function") {
    return null;
  }

  return git as RemoteMergeGit;
}

async function readSelectedPlan(paths: PlanPaths): Promise<SelectedPlan> {
  if (!existsSync(paths.plan)) {
    throw new Error(`Plan does not exist: ${paths.plan}`);
  }

  const planContent = await readFile(paths.plan, "utf8");
  const logContent = existsSync(paths.log) ? await readFile(paths.log, "utf8") : "";

  return { paths, planContent, logContent };
}

function commandFailureReason(prefix: string, result: GitCommandResult): string {
  const details = firstLine(commandOutput(result));
  return details ? `${prefix}: ${details}` : `${prefix}.`;
}

function failedMergeCommandSummary(result: GitCommandResult): string {
  return [
    `$ ${result.command}`,
    `exit code: ${result.status}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ].filter(Boolean).join("\n");
}

function commandOutput(result: ProcessResult): string {
  return (result.stderr.trim() || result.stdout.trim()).trim();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

function parseExistingPullRequest(output: string): ExistingPullRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`Failed to parse PR list JSON: ${output.trim()}`);
  }

  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const item = value[0] as GhPullRequestListItem;
  const url = typeof item.url === "string" ? item.url : "";
  if (!url) {
    return null;
  }

  return {
    url,
    title: typeof item.title === "string" ? item.title : "",
    isDraft: item.isDraft === true,
  };
}

function pullRequestTitle(planContent: string, sourceBranch: string): string {
  const match = planContent.match(/^#\s+Plan:\s*(.+)\s*$/m);
  const title = match?.[1]?.trim();

  return title ? title.slice(0, 120) : sourceBranch;
}

function buildPullRequestBody(options: {
  repoRoot: string;
  planPath: string;
  sourceBranch: string;
  targetBranch: string;
}): string {
  return [
    "## Summary",
    "",
    "Ready PR opened for remote merge.",
    "",
    `Plan: \`${relativePath(options.repoRoot, options.planPath)}\``,
    `Branch: \`${options.sourceBranch}\``,
    `Target: \`${options.targetBranch}\``,
    "",
  ].join("\n");
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isRetryableRemoteMergeFailure(result: GitCommandResult): boolean {
  const output = [result.stderr, result.stdout].join("\n").toLowerCase();

  return [
    "conflict",
    "out of date",
    "outdated",
    "not mergeable",
    "update branch",
    "base branch was modified",
    "head branch was modified",
    "must be rebased",
  ].some((pattern) => output.includes(pattern));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
