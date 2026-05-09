import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Router } from "../src/router";
import { MarkdownState } from "../src/state";

test("route creates a new plan when no lock or plan is selected", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);

    const decision = await new Router(state).route("Add router state files", {
      branchName: "codex/router-state",
      planTitle: "Router State",
      receivedAt: "2026-05-09 12:00",
    });

    const planDir = path.join(root, ".crack", "plans", "codex-router-state");
    assert.equal(decision.action, "create_new_plan");
    assert.equal(decision.target, path.join(planDir, "plan.md"));
    assert.match(await readFile(path.join(planDir, "plan.md"), "utf8"), /Branch: codex\/router-state/);
    assert.match(await readFile(path.join(planDir, "queue.md"), "utf8"), /# Queue/);
  });
});

test("route appends to inbox while PR lock exists", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    await state.setPrLock({
      branchName: "codex/reviewing",
      prUrl: "https://github.com/example/repo/pull/1",
      reason: "PR is reviewing.",
    });

    const decision = await new Router(state).route("Start another feature", {
      receivedAt: "2026-05-09 12:00",
    });

    assert.equal(decision.action, "pause_for_pr_review");
    assert.match(await readFile(path.join(root, ".crack", "inbox.md"), "utf8"), /> Start another feature/);
  });
});

test("route appends to an existing plan queue when selected", async () => {
  await withRepo(async (root) => {
    const state = new MarkdownState(root);
    const plan = await state.createPlan({
      branchName: "codex/current",
      planTitle: "Current",
      prompt: "Initial request",
      reason: "test setup",
      receivedAt: "2026-05-09 12:00",
    });

    const decision = await new Router(state).route("Add dependent follow-up", {
      planPath: plan.directory,
      reason: "Depends on current plan.",
      receivedAt: "2026-05-09 12:05",
    });

    assert.equal(decision.action, "route_to_existing_plan");
    const queue = await readFile(plan.queue, "utf8");
    assert.match(queue, /> Add dependent follow-up/);
    assert.match(queue, /Depends on current plan\./);
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
