import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { parseGitStatus } from "./git";
import type { GitStatusSnapshot } from "./git";
import { CodexMergeAgent } from "./merge-agent";
import type { MergeAgent } from "./merge-agent";
import { branchNameFromPlan, checkPlanReady } from "./plan-readiness";
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

type SelectedPlan = {
  paths: PlanPaths;
  planContent: string;
  logContent: string;
};

export class GitCliLocalMergeGit implements LocalMergeGit {
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

  private async runGit(args: string[]): Promise<GitCommandResult> {
    const result = await runProcess("git", args, { cwd: this.repoRoot });
    return {
      ...result,
      command: ["git", ...args].join(" "),
    };
  }
}

export class MergeRunner {
  private readonly state: MarkdownState;
  private readonly agent: MergeAgent;
  private readonly git: LocalMergeGit;

  constructor(
    state: MarkdownState,
    agent: MergeAgent = new CodexMergeAgent(),
    git?: LocalMergeGit,
  ) {
    this.state = state;
    this.agent = agent;
    this.git = git ?? new GitCliLocalMergeGit(state.repoRoot);
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
        gitFailureReason(`Failed to switch to ${targetBranch}`, switchResult),
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
        gitFailureReason(`Failed to merge ${sourceBranch}`, mergeResult),
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

  private async resolveConflicts(options: {
    selectedPlan: SelectedPlan;
    sourceBranch: string;
    targetBranch: string;
    mergeResult: GitCommandResult;
    receivedAt?: string;
  }): Promise<LocalMergeResult> {
    const gitStatus = await this.git.status();
    const agentResult = await this.agent.resolveConflicts({
      repoRoot: this.state.repoRoot,
      planPath: options.selectedPlan.paths.plan,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      mergeMode: "local",
      gitStatus: gitStatus.raw,
      failedMergeCommand: failedMergeCommandSummary(options.mergeResult),
    });

    if (agentResult.status === "needs_work") {
      return this.needsWork(
        options.selectedPlan,
        options.sourceBranch,
        options.targetBranch,
        `Merge agent needs work: ${agentResult.reason}`,
        options.receivedAt,
      );
    }

    const remainingUnmergedPaths = await this.git.unmergedPaths();
    if (remainingUnmergedPaths.length > 0) {
      return this.needsWork(
        options.selectedPlan,
        options.sourceBranch,
        options.targetBranch,
        `Unmerged paths remain after merge agent: ${remainingUnmergedPaths.join(", ")}.`,
        options.receivedAt,
      );
    }

    if (await this.git.hasPendingMergeCommit()) {
      const commitResult = await this.git.commitMerge();
      if (commitResult.status !== 0) {
        return this.needsWork(
          options.selectedPlan,
          options.sourceBranch,
          options.targetBranch,
          gitFailureReason("Failed to commit resolved merge", commitResult),
          options.receivedAt,
        );
      }
    }

    const summary = `Merged local branch \`${options.sourceBranch}\` into \`${options.targetBranch}\` after conflict resolution.`;
    await this.state.appendPlanLog(
      options.selectedPlan.paths,
      [
        `Merge agent summary: ${agentResult.summary}`,
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

async function readSelectedPlan(paths: PlanPaths): Promise<SelectedPlan> {
  if (!existsSync(paths.plan)) {
    throw new Error(`Plan does not exist: ${paths.plan}`);
  }

  const planContent = await readFile(paths.plan, "utf8");
  const logContent = existsSync(paths.log) ? await readFile(paths.log, "utf8") : "";

  return { paths, planContent, logContent };
}

function gitFailureReason(prefix: string, result: GitCommandResult): string {
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
