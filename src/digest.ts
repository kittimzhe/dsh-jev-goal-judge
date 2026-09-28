/**
 * The round observer: turns the live `session/event` stream into bounded
 * per-round digests. It owns no I/O and no dsh services — index.ts feeds it
 * events, the judge reads the digest at `agent/turn-stopping`.
 *
 * Round boundaries are exact: a `user/message` whose `source.kind === 'goal'`
 * opens round `source.round`, and only the turn that opened a round is judged
 * when it stops — a human interjection between rounds accumulates nothing the
 * judge will act on.
 * @module dsh-jev-goal-judge/digest
 */
import type { RoundDigest, ToolEntry } from './types.ts'
import type { Settings } from './config.ts'

/** A session event, structurally: `{type, data}` plus whatever else it carries. */
export interface ObservedEvent {
  readonly type: string
  readonly data?: unknown
}

/** Defensive view of a user/assistant message's `source` field. */
interface MessageSource {
  readonly kind?: string
  readonly round?: number
  readonly callId?: string
}

/** Defensive view of a message with content blocks. */
interface MessageLike {
  readonly content?: unknown
  readonly source?: MessageSource
}

/** Mutable accumulator for one open round. */
interface RoundAccumulator {
  assistantText: string
  tools: ToolEntry[]
  finalMessage: string
  pendingCalls: Map<string, string>
}

/** Per-agent observation state. */
export interface AgentRoundState {
  /** Turn number → the goal round that opened it. */
  readonly goalTurns: Map<number, number>
  /** The turn number of the most recent `turn/start`. */
  lastTurn: number
  /** The round whose digest is open, if any. */
  activeRound: number | undefined
  digest: RoundAccumulator | undefined
  previousFinals: string[]
  /** Goal id the current state belongs to. */
  goalKey: string | undefined
}

/** Extract text from a message's content blocks, defensively. */
export function messageText(message: unknown): string {
  const like = message as MessageLike | undefined
  const content = like?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n')
}

function messageSource(message: unknown): MessageSource {
  const like = message as MessageLike | undefined
  return like?.source ?? {}
}

function clampTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

/** Observes session events for one agent and produces bounded round digests. */
export class RoundObserver {
  private readonly states = new Map<unknown, AgentRoundState>()

  constructor(private readonly settings: Pick<Settings,
    | 'assistantTailChars'
    | 'finalMessageChars'
    | 'maxToolEntries'
    | 'previousFinals'
    | 'previousFinalChars'
  >) {}

  /** Observation state of one agent, created on first sight. */
  state(agent: unknown): AgentRoundState {
    const existing = this.states.get(agent)
    if (existing !== undefined) return existing
    const fresh: AgentRoundState = {
      goalTurns: new Map(),
      lastTurn: 0,
      activeRound: undefined,
      digest: undefined,
      previousFinals: [],
      goalKey: undefined,
    }
    this.states.set(agent, fresh)
    return fresh
  }

  /** Drop all state for an agent (session restart, disposal). */
  reset(agent: unknown): void {
    this.states.delete(agent)
  }

  /** Drop all state for every agent (plugin disposal). */
  resetAll(): void {
    this.states.clear()
  }

  /** Re-scope state to a new goal: budgets aside, digests restart from zero. */
  reScopeGoal(agent: unknown, goalId: string): void {
    const state = this.state(agent)
    if (state.goalKey === goalId) return
    this.states.set(agent, {
      goalTurns: new Map(),
      lastTurn: state.lastTurn,
      activeRound: undefined,
      digest: undefined,
      previousFinals: [],
      goalKey: goalId,
    })
  }

  /** Feed one observed session event. */
  observe(agent: unknown, event: ObservedEvent): void {
    const state = this.state(agent)
    switch (event.type) {
      case 'turn/start': {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number') state.lastTurn = turn
        return
      }
      case 'user/message': {
        const source = messageSource(event.data)
        if (source.kind !== 'goal' || typeof source.round !== 'number' || source.round <= 0) return
        // Close any open round before opening the next: its final message is
        // already captured, and the new round starts from a clean accumulator.
        this.closeRound(state)
        state.activeRound = source.round
        state.goalTurns.set(state.lastTurn, source.round)
        state.digest = { assistantText: '', tools: [], finalMessage: '', pendingCalls: new Map() }
        return
      }
      case 'assistant/message': {
        const digest = state.digest
        if (digest === undefined) return
        const text = messageText((event.data as { message?: unknown } | undefined)?.message)
        if (text.length === 0) return
        digest.assistantText = clampTail(digest.assistantText + '\n' + text, this.settings.assistantTailChars)
        digest.finalMessage = clampTail(text, this.settings.finalMessageChars)
        return
      }
      case 'tool/call': {
        const digest = state.digest
        if (digest === undefined) return
        const data = event.data as { callId?: unknown; name?: unknown } | undefined
        if (typeof data?.callId !== 'string' || typeof data?.name !== 'string') return
        digest.pendingCalls.set(data.callId, data.name)
        return
      }
      case 'tool/result': {
        const digest = state.digest
        if (digest === undefined) return
        const data = event.data as { message?: unknown; error?: unknown } | undefined
        const callId = messageSource(data?.message).callId
        if (typeof callId !== 'string') return
        const name = digest.pendingCalls.get(callId)
        if (name === undefined) return
        digest.pendingCalls.delete(callId)
        if (digest.tools.length >= this.settings.maxToolEntries) return
        digest.tools.push({ name, ok: data?.error === undefined })
        return
      }
      default:
        return
    }
  }

  /** Freeze the open round's digest into `previousFinals`. */
  private closeRound(state: AgentRoundState): void {
    const digest = state.digest
    state.digest = undefined
    state.activeRound = undefined
    if (digest === undefined) return
    const final = clampTail(digest.finalMessage, this.settings.previousFinalChars)
    if (final.length === 0) return
    state.previousFinals.push(final)
    if (state.previousFinals.length > this.settings.previousFinals) {
      state.previousFinals.splice(0, state.previousFinals.length - this.settings.previousFinals)
    }
  }

  /**
   * The digest a judge should evaluate for the turn about to stop, if any.
   * @param agent - the agent whose turn is closing.
   * @param turn - the closing turn number.
   * @returns the round digest and its number, or `undefined` when this turn is
   *   not a goal round (a human interjection, the session's first turn, …).
   */
  digestForTurn(agent: unknown, turn: number): { round: number; digest: RoundDigest; previousFinals: readonly string[] } | undefined {
    const state = this.states.get(agent)
    if (state === undefined) return undefined
    const round = state.goalTurns.get(turn)
    if (round === undefined) return undefined
    const digest = state.digest
    if (digest === undefined || state.activeRound !== round) return undefined
    return {
      round,
      digest: {
        round,
        assistantTail: digest.assistantText,
        tools: [...digest.tools],
        finalMessage: digest.finalMessage,
      },
      previousFinals: [...state.previousFinals],
    }
  }
}
