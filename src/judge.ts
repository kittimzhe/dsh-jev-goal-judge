/**
 * The judge: builds the one-call question fan-out from a round digest, and
 * routes parsed answers into a verdict. Routing is deterministic and
 * auditable — the noul thresholds decide, the `action` choice only breaks
 * ties and corroborates — so a threshold change replays exactly over logged
 * answers.
 * @module dsh-jev-goal-judge/judge
 */
import type { Settings } from './config.ts'
import type {
  JevAnswers,
  JevQuestion,
  Judgment,
  JudgeState,
  Verdict,
} from './types.ts'
import { choice, noul, score } from './types.ts'

/** Confidence floor for the `action` choice; below it the judge stays silent. */
export const ACTION_CONFIDENCE_FLOOR = 0.5

/**
 * Build the question set for one judgment call. Instruction strings are fixed
 * — transcript text lives only in `state`, so tool output can never rewrite
 * what is being asked.
 * @param state - the bounded judgment state.
 * @returns question id → question.
 */
export function buildJudgeQuestions(state: JudgeState): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    achieved: noul(
      'The work reported in `roundDigest` satisfies the whole `objective`, not merely a part of it',
    ),
    evidence: noul(
      '`roundDigest` contains concrete evidence that `objective` is achieved — completed artifacts, passing checks, or verified results — not only a claim that it is done',
    ),
    progress: score(
      'How much of `objective` did the work in `roundDigest` move toward completion',
      ['none', 'marginal', 'partial', 'substantial', 'complete'],
    ),
    action: choice(
      'Given `objective`, `round`, and `roundDigest`, the single best next action for the agent is',
      {
        continue: 'The round made progress; keep working in the next round as planned',
        'verify-complete':
          'The objective appears achieved; the agent should verify and mark the goal complete now instead of spending another round',
        'report-blocked':
          'A concrete obstacle persists across rounds; the agent should report the goal blocked with that condition or take a materially different approach',
      },
    ),
  }
  if (state.previousFinals.length > 0) {
    questions['sameObstacle'] = noul(
      'The obstacle described in `roundDigest.finalMessage` is materially the same obstacle described in `previousFinals`',
    )
  }
  return questions
}

function noulOf(answers: JevAnswers, id: string): number | undefined {
  const answer = answers[id]
  return answer !== undefined && answer.type === 'noul' ? answer.noul : undefined
}

/** Probability mass on the two lowest progress levels, from a score answer. */
export function lowProgressMass(answers: JevAnswers): number | undefined {
  const answer = answers['progress']
  if (answer === undefined || answer.type !== 'score' || answer.probabilities === undefined) {
    return answer === undefined || answer.type !== 'score' ? undefined : answer.score <= 0.5 ? 1 : 0
  }
  // Score probabilities arrive keyed by criterion index; 0/1 are none/marginal.
  const none = answer.probabilities['0'] ?? 0
  const marginal = answer.probabilities['1'] ?? 0
  return none + marginal
}

/**
 * Route parsed answers into a verdict.
 * @param answers - the parsed decision answers.
 * @param settings - threshold settings.
 * @param round - the round that just closed.
 * @returns the judgment; `uncertain` when any routed input is missing or the
 *   action confidence is below the floor (fail-open, never a guess).
 */
export function routeJudgment(answers: JevAnswers, settings: Settings, round: number): Judgment {
  const achieved = noulOf(answers, 'achieved')
  const evidence = noulOf(answers, 'evidence')
  const sameObstacle = noulOf(answers, 'sameObstacle')
  const mass = lowProgressMass(answers)
  const action = answers['action']
  const actionChoice = action !== undefined && action.type === 'choice' ? action.choice : undefined
  const actionConfidence = action !== undefined && action.type === 'choice' ? action.confidence : undefined
  const progress = answers['progress']
  const progressConfidence = progress !== undefined && progress.type === 'score' ? progress.confidence : undefined
  const confidence = Math.min(...[actionConfidence, progressConfidence].filter((value): value is number => value !== undefined))
  const uncertain: Judgment = {
    verdict: 'uncertain',
    confidence: Number.isFinite(confidence) ? confidence : 0,
  }
  if (achieved === undefined || evidence === undefined || mass === undefined) return uncertain
  if (actionConfidence === undefined || actionConfidence < ACTION_CONFIDENCE_FLOOR) return uncertain

  const verifyComplete = achieved >= settings.achievedMin && evidence >= settings.evidenceMin
  const reportBlocked =
    round >= settings.minRoundForBlocked &&
    sameObstacle !== undefined &&
    sameObstacle >= settings.sameObstacleMin &&
    mass >= settings.lowProgressMass
  if (verifyComplete && reportBlocked) {
    // Both gates passing is contradictory; the action choice breaks the tie.
    const verdict: Verdict = actionChoice === 'report-blocked' ? 'report-blocked' : 'verify-complete'
    return { verdict, achieved, evidence, sameObstacle, lowProgressMass: mass, actionChoice, actionConfidence, confidence }
  }
  if (verifyComplete) {
    return { verdict: 'verify-complete', achieved, evidence, sameObstacle, lowProgressMass: mass, actionChoice, actionConfidence, confidence }
  }
  if (reportBlocked) {
    return { verdict: 'report-blocked', achieved, evidence, sameObstacle, lowProgressMass: mass, actionChoice, actionConfidence, confidence }
  }
  return { verdict: 'on-track', achieved, evidence, sameObstacle, lowProgressMass: mass, actionChoice, actionConfidence, confidence }
}
