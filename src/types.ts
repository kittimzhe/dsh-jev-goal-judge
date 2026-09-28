/**
 * Wire types shared by the Jev client, the judge, and tests: the typed
 * question/answer shapes of the System One decisions API (verified against
 * `dsh-jev-interceptor` and the OpenRouter alpha decisions endpoint), the
 * bounded round digest the observer accumulates, and the verdict vocabulary
 * the router emits.
 *
 * The plugin's contract with the provider is strict: any answer whose shape
 * deviates from these types is a degrade, never a guess.
 * @module dsh-jev-goal-judge/types
 */

/** One Jev `noul` question: the probability that `instructions` is true of `state`. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

/** One Jev `choice` question: pick exactly one option id; `criteria` maps option id to judging notes. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string>>
}

/** One Jev `score` question: a position on ordered `levels`, coarsest first. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly levels: readonly string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Parsed `noul` answer: probability the statement holds. */
export interface NoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

/** Parsed `choice` answer: selection, full distribution, calibrated confidence. */
export interface ChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

/** Parsed `score` answer: probability-weighted level position (0-based) with confidence. */
export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly confidence: number
  readonly probabilities?: Readonly<Record<string, number>>
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer
export type JevAnswers = Readonly<Record<string, JevAnswer>>

/** Fixed question ids of the goal-round judgment fan-out. */
export const QUESTION_IDS = ['achieved', 'evidence', 'progress', 'sameObstacle', 'action'] as const

/** Ordered progress levels of the `progress` score question, coarsest first. */
export const PROGRESS_LEVELS = ['none', 'marginal', 'partial', 'substantial', 'complete'] as const

/** Options of the `action` choice question. */
export const ACTION_OPTIONS = ['continue', 'verify-complete', 'report-blocked'] as const

/** What the judge concluded about the round that just closed. */
export type Verdict =
  | 'on-track'
  | 'verify-complete'
  | 'report-blocked'
  | 'uncertain'

/** One tool activity entry in a round digest. */
export interface ToolEntry {
  readonly name: string
  readonly ok: boolean
}

/** Bounded digest of one goal round, accumulated from session events. */
export interface RoundDigest {
  readonly round: number
  readonly assistantTail: string
  readonly tools: readonly ToolEntry[]
  readonly finalMessage: string
}

/** The full `state` payload of the judgment call. */
export interface JudgeState {
  readonly objective: string
  readonly round: number
  readonly maxRounds: number
  readonly roundDigest: RoundDigest
  readonly previousFinals: readonly string[]
}

/** The measured judgment one round end produced. */
export interface Judgment {
  readonly verdict: Verdict
  readonly achieved?: number
  readonly evidence?: number
  readonly sameObstacle?: number
  readonly lowProgressMass?: number
  readonly actionChoice?: string
  readonly actionConfidence?: number
  readonly confidence: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Build a `noul` question. */
export function noul(instructions: string): NoulQuestion {
  return { type: 'noul', instructions }
}

/** Build a `choice` question over `criteria` (option id → judging note). */
export function choice(instructions: string, criteria: Readonly<Record<string, string>>): ChoiceQuestion {
  return { type: 'choice', instructions, criteria }
}

/** Build a `score` question over ordered `levels`, coarsest first. */
export function score(instructions: string, levels: readonly string[]): ScoreQuestion {
  return { type: 'score', instructions, levels }
}

/**
 * Strictly parse a decisions-API answer body.
 * @param body - the decoded `answers` member of the provider response.
 * @returns every member parsed to its typed shape.
 * @throws when any member deviates from the wire contract.
 */
export function parseAnswers(body: unknown): JevAnswers {
  if (!isRecord(body)) throw new Error('jev: response body is not an object')
  const answers: Record<string, JevAnswer> = {}
  for (const [id, raw] of Object.entries(body)) {
    if (!isRecord(raw)) throw new Error(`jev: answer "${id}" is not an object`)
    if (raw['type'] === 'noul') {
      if (!isProbability(raw['noul'])) throw new Error(`jev: noul answer "${id}" lacks a probability`)
      answers[id] = { type: 'noul', noul: raw['noul'] }
      continue
    }
    if (raw['type'] === 'choice') {
      if (typeof raw['choice'] !== 'string') throw new Error(`jev: choice answer "${id}" lacks a selection`)
      if (!isProbability(raw['confidence'])) throw new Error(`jev: choice answer "${id}" lacks confidence`)
      if (!isRecord(raw['probabilities'])) throw new Error(`jev: choice answer "${id}" lacks probabilities`)
      for (const member of Object.values(raw['probabilities'])) {
        if (!isProbability(member)) throw new Error(`jev: choice answer "${id}" has a non-numeric probability`)
      }
      answers[id] = {
        type: 'choice',
        choice: raw['choice'],
        probabilities: raw['probabilities'] as Record<string, number>,
        confidence: raw['confidence'],
      }
      continue
    }
    if (raw['type'] === 'score') {
      if (!isProbability(raw['confidence'])) throw new Error(`jev: score answer "${id}" lacks confidence`)
      if (typeof raw['score'] !== 'number' || !Number.isFinite(raw['score'])) {
        throw new Error(`jev: score answer "${id}" lacks a score`)
      }
      let probabilities: Record<string, number> | undefined
      if (isRecord(raw['probabilities'])) {
        for (const member of Object.values(raw['probabilities'])) {
          if (!isProbability(member)) throw new Error(`jev: score answer "${id}" has a non-numeric probability`)
        }
        probabilities = raw['probabilities'] as Record<string, number>
      }
      answers[id] = {
        type: 'score',
        score: raw['score'],
        confidence: raw['confidence'],
        ...(probabilities === undefined ? {} : { probabilities }),
      }
      continue
    }
    throw new Error(`jev: answer "${id}" has an unknown type`)
  }
  return answers
}
