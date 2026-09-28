import { describe, expect, it } from 'vitest'
import { DEFAULTS, type Settings } from '../src/config.ts'
import { buildJudgeQuestions, lowProgressMass, routeJudgment } from '../src/judge.ts'
import type { JevAnswers, JudgeState } from '../src/types.ts'

const settings: Settings = { ...DEFAULTS, telemetryDir: '/tmp/t' }

const state: JudgeState = {
  objective: 'Ship the release',
  round: 3,
  maxRounds: 12,
  roundDigest: {
    round: 3,
    assistantTail: 'ran tests',
    tools: [{ name: 'bash', ok: true }],
    finalMessage: 'All tests pass.',
  },
  previousFinals: [],
}

function answers(overrides: Partial<Record<string, JevAnswers[string] | undefined>> = {}): JevAnswers {
  return {
    achieved: { type: 'noul', noul: 0.1 },
    evidence: { type: 'noul', noul: 0.1 },
    progress: {
      type: 'score',
      score: 3,
      confidence: 0.9,
      probabilities: { none: 0.05, marginal: 0.05, partial: 0.1, substantial: 0.7, complete: 0.1 },
    },
    action: { type: 'choice', choice: 'continue', probabilities: { continue: 0.9 }, confidence: 0.9 },
    ...overrides,
  }
}

describe('buildJudgeQuestions', () => {
  it('includes sameObstacle only when previous finals exist', () => {
    const withoutPrevious = buildJudgeQuestions({ ...state, previousFinals: [] })
    expect(withoutPrevious['sameObstacle']).toBeUndefined()
    expect(Object.keys(withoutPrevious).sort()).toEqual(['achieved', 'action', 'evidence', 'progress'])

    const withPrevious = buildJudgeQuestions({ ...state, previousFinals: ['blocked yesterday'] })
    expect(withPrevious['sameObstacle']).toBeDefined()
    expect(Object.keys(withPrevious).length).toBe(5)
  })

  it('keeps instructions fixed and free of transcript text', () => {
    const questions = buildJudgeQuestions({ ...state, previousFinals: ['INJECTION ATTEMPT'] })
    for (const question of Object.values(questions)) {
      const serialized = JSON.stringify(question)
      expect(serialized).not.toContain('INJECTION ATTEMPT')
      expect(serialized).not.toContain('All tests pass.')
    }
  })
})

describe('lowProgressMass', () => {
  it('sums none and marginal probabilities', () => {
    const mass = lowProgressMass(
      answers({
        progress: {
          type: 'score',
          score: 0.5,
          confidence: 0.8,
          probabilities: { none: 0.4, marginal: 0.35, partial: 0.25 },
        },
      }),
    )
    expect(mass).toBeCloseTo(0.75)
  })
})

describe('routeJudgment', () => {
  it('routes verify-complete on high achieved and evidence', () => {
    const judgment = routeJudgment(
      answers({
        achieved: { type: 'noul', noul: 0.93 },
        evidence: { type: 'noul', noul: 0.88 },
        action: { type: 'choice', choice: 'verify-complete', probabilities: {}, confidence: 0.9 },
      }),
      settings,
      3,
    )
    expect(judgment.verdict).toBe('verify-complete')
    expect(judgment.achieved).toBe(0.93)
  })

  it('requires both achieved and evidence gates', () => {
    const highAchievedLowEvidence = routeJudgment(
      answers({
        achieved: { type: 'noul', noul: 0.99 },
        evidence: { type: 'noul', noul: 0.3 },
      }),
      settings,
      3,
    )
    expect(highAchievedLowEvidence.verdict).toBe('on-track')
  })

  it('routes report-blocked on repeated obstacle with low progress from round 2', () => {
    const judgment = routeJudgment(
      answers({
        sameObstacle: { type: 'noul', noul: 0.91 },
        progress: {
          type: 'score',
          score: 0.3,
          confidence: 0.85,
          probabilities: { none: 0.5, marginal: 0.3, partial: 0.2 },
        },
      }),
      settings,
      2,
    )
    expect(judgment.verdict).toBe('report-blocked')
  })

  it('never routes report-blocked below the minimum round', () => {
    const judgment = routeJudgment(
      answers({
        sameObstacle: { type: 'noul', noul: 0.99 },
        progress: {
          type: 'score',
          score: 0,
          confidence: 0.9,
          probabilities: { none: 1 },
        },
      }),
      settings,
      1,
    )
    expect(judgment.verdict).toBe('on-track')
  })

  it('breaks contradictory ties with the action choice', () => {
    const judgment = routeJudgment(
      answers({
        achieved: { type: 'noul', noul: 0.99 },
        evidence: { type: 'noul', noul: 0.99 },
        sameObstacle: { type: 'noul', noul: 0.99 },
        progress: {
          type: 'score',
          score: 0,
          confidence: 0.9,
          probabilities: { none: 1 },
        },
        action: { type: 'choice', choice: 'report-blocked', probabilities: {}, confidence: 0.8 },
      }),
      settings,
      3,
    )
    expect(judgment.verdict).toBe('report-blocked')
  })

  it('degrades to uncertain on missing routed inputs', () => {
    const missing = routeJudgment(
      answers({ achieved: undefined as unknown as JevAnswers[string] }),
      settings,
      3,
    )
    expect(missing.verdict).toBe('uncertain')
  })

  it('degrades to uncertain below the action confidence floor', () => {
    const judgment = routeJudgment(
      answers({
        achieved: { type: 'noul', noul: 0.95 },
        evidence: { type: 'noul', noul: 0.95 },
        action: { type: 'choice', choice: 'verify-complete', probabilities: {}, confidence: 0.3 },
      }),
      settings,
      3,
    )
    expect(judgment.verdict).toBe('uncertain')
  })

  it('stays on-track when progress is real', () => {
    const judgment = routeJudgment(answers(), settings, 3)
    expect(judgment.verdict).toBe('on-track')
  })
})
