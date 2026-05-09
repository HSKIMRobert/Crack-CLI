import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type PlanPaths = {
  directory: string;
  plan: string;
  queue: string;
  log: string;
};

export type ActivePlan = PlanPaths & {
  branchName: string;
  planContent: string;
  queueContent: string;
};

export type QueuedRequest = {
  prompt: string;
  reason: string;
  receivedAt: string;
};

export function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);

  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(start);
    }

    current = parent;
  }
}

export function timestamp(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-")
    + " "
    + [pad(date.getHours()), pad(date.getMinutes())].join(":");
}

export function quotePrompt(prompt: string): string {
  const lines = prompt.trim().split(/\r?\n/);
  const nonEmptyLines = lines.length > 0 ? lines : [""];

  return nonEmptyLines.map((line) => (line ? `> ${line}` : ">")).join("\n");
}

export function slugify(value: string, fallback = "request"): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/\.lock$/i, "-lock");

  return slug || fallback;
}

export function planDirectoryName(branchName: string): string {
  return slugify(branchName);
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim().slice(0, 80) : "User Request";
}

export class MarkdownState {
  readonly repoRoot: string;
  readonly crackDir: string;
  readonly inboxPath: string;
  readonly prLockPath: string;
  readonly plansDir: string;

  constructor(repoRoot = findRepoRoot()) {
    this.repoRoot = path.resolve(repoRoot);
    this.crackDir = path.join(this.repoRoot, ".crack");
    this.inboxPath = path.join(this.crackDir, "inbox.md");
    this.prLockPath = path.join(this.crackDir, "pr-lock.md");
    this.plansDir = path.join(this.crackDir, "plans");
  }

  async initialize(): Promise<void> {
    await mkdir(this.plansDir, { recursive: true });

    if (!existsSync(this.inboxPath)) {
      await writeFile(this.inboxPath, "# Inbox\n\n", "utf8");
    }
  }

  async readPrLock(): Promise<string | null> {
    if (!existsSync(this.prLockPath)) {
      return null;
    }

    return readFile(this.prLockPath, "utf8");
  }

  planPaths(branchName: string): PlanPaths {
    const directory = path.join(this.plansDir, planDirectoryName(branchName));

    return {
      directory,
      plan: path.join(directory, "plan.md"),
      queue: path.join(directory, "queue.md"),
      log: path.join(directory, "log.md"),
    };
  }

  existingPlanPaths(planPath: string): PlanPaths {
    const absolutePath = path.isAbsolute(planPath) ? planPath : path.join(this.repoRoot, planPath);
    const directory = path.basename(absolutePath) === "plan.md" ? path.dirname(absolutePath) : absolutePath;

    return {
      directory,
      plan: path.join(directory, "plan.md"),
      queue: path.join(directory, "queue.md"),
      log: path.join(directory, "log.md"),
    };
  }

  async listActivePlans(): Promise<ActivePlan[]> {
    await this.initialize();

    const entries = await readdir(this.plansDir, { withFileTypes: true });
    const plans: ActivePlan[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const directory = path.join(this.plansDir, entry.name);
      const plan = path.join(directory, "plan.md");

      if (!existsSync(plan)) {
        continue;
      }

      const queue = path.join(directory, "queue.md");
      const log = path.join(directory, "log.md");
      const planContent = await readFile(plan, "utf8");
      const queueContent = existsSync(queue) ? await readFile(queue, "utf8") : "";

      plans.push({
        directory,
        plan,
        queue,
        log,
        branchName: branchNameFromPlan(planContent) ?? entry.name,
        planContent,
        queueContent,
      });
    }

    return plans.sort((left, right) => left.directory.localeCompare(right.directory));
  }

  async appendInbox(prompt: string, reason: string, receivedAt = timestamp()): Promise<string> {
    await this.initialize();
    await appendFile(this.inboxPath, queuedRequestEntry(prompt, reason, receivedAt), "utf8");

    return this.inboxPath;
  }

  async readInboxRequests(): Promise<QueuedRequest[]> {
    await this.initialize();
    const content = existsSync(this.inboxPath) ? await readFile(this.inboxPath, "utf8") : "";

    return parseQueuedRequests(content);
  }

  async writeInboxRequests(requests: QueuedRequest[]): Promise<string> {
    await this.initialize();
    await writeFile(this.inboxPath, inboxTemplate(requests), "utf8");

    return this.inboxPath;
  }

  async createPlan(options: {
    branchName: string;
    planTitle: string;
    prompt: string;
    reason: string;
    receivedAt?: string;
  }): Promise<PlanPaths> {
    await this.initialize();

    const branchName = options.branchName.trim();
    if (!branchName) {
      throw new Error("branchName is required");
    }

    const planTitle = options.planTitle.trim() || titleFromPrompt(options.prompt);
    const paths = this.planPaths(branchName);

    if (existsSync(paths.directory)) {
      throw new Error(`Plan already exists: ${paths.directory}`);
    }

    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.plan, planTemplate(planTitle, branchName, options.prompt, options.reason), "utf8");
    await writeFile(paths.queue, "# Queue\n\n", "utf8");
    await writeFile(paths.log, logTemplate(branchName, options.reason, options.receivedAt ?? timestamp()), "utf8");

    return paths;
  }

  async appendQueue(planPath: string, prompt: string, reason: string, receivedAt = timestamp()): Promise<string> {
    await this.initialize();

    const paths = this.existingPlanPaths(planPath);
    if (!existsSync(paths.directory)) {
      throw new Error(`Plan does not exist: ${paths.directory}`);
    }

    if (!existsSync(paths.queue)) {
      await writeFile(paths.queue, "# Queue\n\n", "utf8");
    }

    await appendFile(paths.queue, queuedRequestEntry(prompt, reason, receivedAt), "utf8");

    return paths.queue;
  }

  async appendPlanLog(planPath: string | PlanPaths, entries: string[], loggedAt = timestamp()): Promise<string> {
    await this.initialize();

    const paths = typeof planPath === "string" ? this.existingPlanPaths(planPath) : planPath;
    if (!existsSync(paths.directory)) {
      throw new Error(`Plan does not exist: ${paths.directory}`);
    }

    if (!existsSync(paths.log)) {
      await writeFile(paths.log, "# Log\n\n", "utf8");
    }

    await appendFile(
      paths.log,
      [
        `## ${loggedAt}`,
        "",
        ...entries.map((entry) => `- ${entry}`),
        "",
      ].join("\n"),
      "utf8",
    );

    return paths.log;
  }

  async setPrLock(options: {
    branchName: string;
    prUrl: string;
    reason: string;
    status?: string;
  }): Promise<string> {
    await this.initialize();

    const branchName = options.branchName.trim();
    if (!branchName) {
      throw new Error("branchName is required");
    }

    const content = [
      "# PR Lock",
      "",
      `Branch: ${branchName}`,
      `PR: ${options.prUrl.trim()}`,
      `Status: ${(options.status ?? "reviewing").trim()}`,
      "",
      options.reason.trim(),
      "",
    ].join("\n");

    await writeFile(this.prLockPath, content, "utf8");
    return this.prLockPath;
  }

  async clearPrLock(): Promise<boolean> {
    if (!existsSync(this.prLockPath)) {
      return false;
    }

    await unlink(this.prLockPath);
    return true;
  }
}

function queuedRequestEntry(prompt: string, reason: string, receivedAt: string): string {
  return [
    "## Queued Request",
    "",
    `Received: ${receivedAt}`,
    "",
    "User prompt:",
    "",
    quotePrompt(prompt),
    "",
    "Reason:",
    "",
    reason.trim(),
    "",
  ].join("\n");
}

export function parseQueuedRequests(content: string): QueuedRequest[] {
  return content
    .split(/^## Queued Request\s*$/m)
    .slice(1)
    .map(parseQueuedRequestSection)
    .filter((request): request is QueuedRequest => request !== null);
}

function parseQueuedRequestSection(section: string): QueuedRequest | null {
  const lines = section.split(/\r?\n/);
  const receivedAt = matchLine(section, /^Received:\s*(.+)\s*$/m) ?? "";
  const promptLabelIndex = lines.findIndex((line) => line.trim() === "User prompt:");
  const reasonLabelIndex = lines.findIndex((line) => line.trim() === "Reason:");

  if (promptLabelIndex < 0 || reasonLabelIndex < 0 || reasonLabelIndex <= promptLabelIndex) {
    return null;
  }

  const prompt = trimOuterEmptyLines(lines.slice(promptLabelIndex + 1, reasonLabelIndex))
    .map((line) => {
      if (line === ">") {
        return "";
      }

      return line.startsWith("> ") ? line.slice(2) : line;
    })
    .join("\n")
    .trim();
  const reason = trimOuterEmptyLines(lines.slice(reasonLabelIndex + 1)).join("\n").trim();

  if (!prompt) {
    return null;
  }

  return { prompt, reason, receivedAt };
}

function inboxTemplate(requests: QueuedRequest[]): string {
  if (requests.length === 0) {
    return "# Inbox\n\n";
  }

  return `# Inbox\n\n${requests
    .map((request) => queuedRequestEntry(request.prompt, request.reason, request.receivedAt))
    .join("\n")}`;
}

function matchLine(content: string, pattern: RegExp): string | undefined {
  return content.match(pattern)?.[1]?.trim();
}

function trimOuterEmptyLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === "") {
    start += 1;
  }

  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

function planTemplate(title: string, branchName: string, prompt: string, reason: string): string {
  return [
    `# Plan: ${title}`,
    "",
    `Branch: ${branchName}`,
    "",
    "## Intent",
    "",
    prompt.trim(),
    "",
    "## Commit Units",
    "",
    "- TODO: Planner should split this request into commit-sized units.",
    "",
    "## Router Note",
    "",
    reason.trim(),
    "",
  ].join("\n");
}

function logTemplate(branchName: string, reason: string, receivedAt: string): string {
  return [
    "# Log",
    "",
    `## ${receivedAt}`,
    "",
    `- Created plan directory for \`${branchName}\`.`,
    `- Reason: ${reason.trim()}`,
    "",
  ].join("\n");
}

function branchNameFromPlan(content: string): string | undefined {
  const match = content.match(/^Branch:\s*(.+)\s*$/m);
  return match?.[1]?.trim() || undefined;
}
