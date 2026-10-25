// Task-fit rungs: the main session tags each delegated task, and quota can only push cheaper
// (docs/superpowers/specs/2026-10-25-task-fit-routing-design.md).
export const DIFFICULTIES = Object.freeze(["easy", "medium", "hard"]);
export const PROTECTED_ROLES = new Set(["planning", "architecture", "review", "sensitive"]);
const TASK_RUNGS = { hard: 1, medium: 2, easy: 4 };

export function taskFitRung({ difficulty = "medium", quotaRung, protectedRole = false, protectedMaxRung = 2, subscriptionFailures = 0 }) {
  if (!DIFFICULTIES.includes(difficulty)) throw new TypeError(`Difficulty must be one of: ${DIFFICULTIES.join(", ")}.`);
  const rungAt = (failures) => {
    // Protected easy work counts as medium.
    const taskRung = TASK_RUNGS[protectedRole && difficulty === "easy" ? "medium" : difficulty];
    const rung = Math.max(Math.max(1, taskRung - failures), quotaRung);
    return Math.min(4, Math.max(1, protectedRole ? Math.min(rung, protectedMaxRung) : rung));
  };
  const rung = rungAt(subscriptionFailures);
  // Capped: another failure here cannot buy a stronger model on this lane.
  return { rung, capped: subscriptionFailures > 0 && rung === rungAt(subscriptionFailures - 1) };
}
