import { MarkdownState, slugify, titleFromPrompt } from "./state";

export type RouteAction = "pause_for_pr_review" | "route_to_existing_plan" | "create_new_plan";

export type RouteDecision = {
  action: RouteAction;
  target: string;
  reason: string;
};

export type RouteOptions = {
  planPath?: string;
  branchName?: string;
  planTitle?: string;
  reason?: string;
  receivedAt?: string;
};

export class Router {
  constructor(private readonly state: MarkdownState) {}

  async route(prompt: string, options: RouteOptions = {}): Promise<RouteDecision> {
    await this.state.initialize();

    if (await this.state.readPrLock()) {
      const reason = options.reason ?? "PR review lock is active, so new requests are paused.";
      const target = await this.state.appendInbox(prompt, reason, options.receivedAt);
      return { action: "pause_for_pr_review", target, reason };
    }

    if (options.planPath) {
      const reason = options.reason ?? "Caller selected an existing active plan.";
      const target = await this.state.appendQueue(options.planPath, prompt, reason, options.receivedAt);
      return { action: "route_to_existing_plan", target, reason };
    }

    const title = options.planTitle ?? titleFromPrompt(prompt);
    const branchName = options.branchName ?? `codex/${slugify(title).toLowerCase()}`;
    const reason = options.reason ?? "No PR lock or selected active plan; created a new plan.";
    const paths = await this.state.createPlan({
      branchName,
      planTitle: title,
      prompt,
      reason,
      receivedAt: options.receivedAt,
    });

    return { action: "create_new_plan", target: paths.plan, reason };
  }
}
