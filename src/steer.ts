/**
 * The steerer: fixed-template advisory notes and the per-goal budgets that
 * bound them. Notes are parameterized only by round numbers — no model- or
 * Jev-generated text is ever echoed into a prompt — and the budgets guarantee
 * the judge can never talk more than the rounds it saves.
 * @module dsh-jev-goal-judge/steer
 */
import type { Settings } from './config.ts'
import type { Verdict } from './types.ts'

/** Steerable verdicts. */
const STEERABLE: readonly Verdict[] = ['verify-complete', 'report-blocked']

/** Per-goal spend of steer nudges. */
interface SteerBudget {
  verifyComplete: number
  reportBlocked: number
}

/** Fixed-template advisory notes, parameterized by round numbers only. */
export function renderSteerNote(verdict: Verdict, round: number): string | undefined {
  if (verdict === 'verify-complete') {
    return [
      '<goal_judge>',
      `The decision layer judged round ${round} against the objective and found the work likely complete, with concrete evidence in this turn.`,
      '',
      'Before this turn closes: re-check the goal\'s completion criteria against the actual workspace state. If the whole objective is achieved, read the current goal with its exact id and revision and mark it complete now. If any part genuinely remains, state precisely which part, and leave the goal active.',
      '</goal_judge>',
    ].join('\n')
  }
  if (verdict === 'report-blocked') {
    return [
      '<goal_judge>',
      `The decision layer judged round ${round} and found the same obstacle reported across rounds with little progress.`,
      '',
      'Before this turn closes: either take a materially different approach to the obstacle in this step, or report the goal blocked with the concrete persistent condition. Repeating the same attempt is the one outcome to avoid.',
      '</goal_judge>',
    ].join('\n')
  }
  return undefined
}

/** Tracks per-goal steer budgets; a fresh goal id starts every budget at zero. */
export class Steerer {
  private readonly budgets = new Map<string, SteerBudget>()

  constructor(private readonly settings: Pick<Settings, 'verifyCompleteMax' | 'reportBlockedMax'>) {}

  /** Drop the budget of a goal that ended (complete, blocked, cleared). */
  forget(goalKey: string | undefined): void {
    if (goalKey !== undefined) this.budgets.delete(goalKey)
  }

  /**
   * Whether a verdict may still steer for a goal.
   * @param verdict - the judgment verdict.
   * @param goalKey - the goal the budgets are scoped to.
   */
  allows(verdict: Verdict, goalKey: string): boolean {
    if (!STEERABLE.includes(verdict)) return false
    const budget = this.budgets.get(goalKey) ?? { verifyComplete: 0, reportBlocked: 0 }
    if (verdict === 'verify-complete') return budget.verifyComplete < this.settings.verifyCompleteMax
    return budget.reportBlocked < this.settings.reportBlockedMax
  }

  /** Spend one unit of budget for a steered verdict. */
  spend(verdict: Verdict, goalKey: string): void {
    const budget = this.budgets.get(goalKey) ?? { verifyComplete: 0, reportBlocked: 0 }
    if (verdict === 'verify-complete') budget.verifyComplete += 1
    else if (verdict === 'report-blocked') budget.reportBlocked += 1
    this.budgets.set(goalKey, budget)
  }
}
