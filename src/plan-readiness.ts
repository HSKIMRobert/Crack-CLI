import { completedCommitUnitNumbers, parseCommitUnits } from "./implementer";

export type PlanReadiness =
  | { ready: true }
  | { ready: false; reason: string };

export function checkPlanReady(planContent: string, logContent: string): PlanReadiness {
  const units = parseCommitUnits(planContent);
  if (units.length === 0) {
    return { ready: false, reason: "Plan has no commit units." };
  }

  const completed = completedCommitUnitNumbers(logContent);
  const remaining = units.filter((unit) => !completed.has(unit.number));
  if (remaining.length > 0) {
    return {
      ready: false,
      reason: `Commit units not complete: ${remaining.map((unit) => unit.number).join(", ")}.`,
    };
  }

  return { ready: true };
}

export function branchNameFromPlan(content: string): string | undefined {
  const match = content.match(/^Branch:\s*(.+)\s*$/m);
  return match?.[1]?.trim() || undefined;
}
