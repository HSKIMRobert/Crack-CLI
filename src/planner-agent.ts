import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withCodexCliDefaults } from "./codex-cli";
import { runProcess } from "./process";

export type PlannerAgentInput = {
  repoRoot: string;
  branchName: string;
  planTitle: string;
  planPath: string;
  queuePath: string;
  logPath: string;
  prompt: string;
  reason: string;
};

export type PlannerAgentResult = {
  path: string;
  finalMessage: string;
};

export interface PlannerAgent {
  writePlan(input: PlannerAgentInput): Promise<PlannerAgentResult>;
}

export type CodexPlannerAgentOptions = {
  command?: string;
  extraArgs?: string[];
};

export class CodexPlannerAgent implements PlannerAgent {
  private readonly command: string;
  private readonly extraArgs: string[];

  constructor(options: CodexPlannerAgentOptions = {}) {
    this.command = options.command ?? "codex";
    this.extraArgs = options.extraArgs ?? [];
  }

  async writePlan(input: PlannerAgentInput): Promise<PlannerAgentResult> {
    const planContent = await readFile(input.planPath, "utf8").catch(() => "");
    const prompt = buildPlannerPrompt(input, planContent);
    const finalMessage = await this.runCodex(prompt, input.repoRoot);
    const writtenPath = parsePlanWritten(finalMessage);

    return { path: writtenPath, finalMessage };
  }

  private async runCodex(prompt: string, repoRoot: string): Promise<string> {
    const tempDir = await mkdtemp(path.join(tmpdir(), "crack-planner-"));
    const outputPath = path.join(tempDir, "last-message.txt");

    try {
      const result = await runProcess(
        this.command,
        [
          "exec",
          "--json",
          "--cd",
          repoRoot,
          "--sandbox",
          "workspace-write",
          "--output-last-message",
          outputPath,
          ...withCodexCliDefaults(this.extraArgs),
          "-",
        ],
        { cwd: repoRoot, input: prompt },
      );

      if (result.status !== 0) {
        const details = result.stderr.trim() || result.stdout.trim();
        const suffix = details ? `: ${details}` : "";
        throw new Error(`Codex planner failed with exit code ${result.status}${suffix}`);
      }

      const finalMessage = await readFile(outputPath, "utf8").catch(() => "");
      return finalMessage.trim() || result.stdout.trim();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function buildPlannerPrompt(input: PlannerAgentInput, planContent = ""): string {
  const planPath = relativePath(input.repoRoot, input.planPath);
  const queuePath = relativePath(input.repoRoot, input.queuePath);
  const logPath = relativePath(input.repoRoot, input.logPath);

  return [
    "You are Agent 1: Planner for the Codex workflow orchestrator.",
    "Rewrite the plan file for the new branch. Do not edit source code or any file other than the plan file.",
    "",
    "Planning rules:",
    "- Follow the conventions in docs/workflow-design.md.",
    "- Keep the plan as readable Markdown, not JSON.",
    "- Split the work into clear commit-sized units.",
    "- Keep each unit concrete enough for a fresh Codex session to implement later.",
    "- Avoid overengineering; prefer clean, simple, readable steps.",
    "",
    "When the plan is written, return exactly one final line:",
    `PLAN_WRITTEN path="${planPath}"`,
    "",
    "Plan metadata:",
    `Branch: ${input.branchName}`,
    `Title: ${input.planTitle}`,
    `Plan path: ${planPath}`,
    `Queue path: ${queuePath}`,
    `Log path: ${logPath}`,
    "",
    "Router reason:",
    fence(input.reason),
    "",
    "User request:",
    fence(input.prompt),
    "",
    "Current plan.md content:",
    planContent.trim() ? fence(planContent) : "None",
  ].join("\n");
}

export function parsePlanWritten(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith("PLAN_WRITTEN "));

  if (!line) {
    throw new Error(`Planner response did not contain a PLAN_WRITTEN line: ${text.trim()}`);
  }

  const match = line.match(/^PLAN_WRITTEN\s+path=(?:"([^"]*)"|'([^']*)'|(\S+))$/);
  if (!match) {
    throw new Error(`Invalid planner response: ${line}`);
  }

  return match[1] ?? match[2] ?? match[3];
}

function fence(value: string): string {
  return ["```text", value.trim(), "```"].join("\n");
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
