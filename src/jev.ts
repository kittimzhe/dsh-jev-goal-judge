/**
 * The Jev decision client: one bounded, cooldown-gated, concurrency-limited
 * call path. Degradation is a first-class outcome — `ask` returns `null` and
 * the caller falls back to stock goal-round behavior, so the plugin never
 * steers on a guess because the provider is down. Telemetry for degraded and
 * answered calls is written here.
 *
 * Failure accounting: timeouts, network errors, and HTTP failures all count
 * toward the cooldown gate; a caller-side abort does not. One retry is
 * attempted for 429/529/5xx inside the remaining budget.
 * @module dsh-jev-goal-judge/jev
 */
import type { JevAnswers, JevQuestion } from './types.ts'
import { parseAnswers } from './types.ts'
import { CooldownGate, Semaphore } from './resilience.ts'
import { estimateCostUsd, type Telemetry } from './telemetry.ts'

/** What one judgment call is about, for telemetry attribution. */
export interface JevCallContext {
  readonly tag: string
  readonly mode: string
  readonly sessionId?: string
  readonly goalId?: string
  readonly round?: number
  readonly signal?: AbortSignal
}

/** A successful decision: parsed answers plus billing facts. */
export interface JevDecision {
  readonly answers: JevAnswers
  readonly model: string
  readonly latencyMs: number
  readonly inputTokens?: number
  readonly costUsd?: number
  readonly cached: false
}

export interface JevClientOptions {
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly failureThreshold: number
  readonly maxConcurrency: number
  readonly resolveKey: () => Promise<string | undefined> | string | undefined
  readonly telemetry: Telemetry
  readonly logger: { warn: (message: string) => void }
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

/** Bounded Jev caller with cooldown and concurrency control. */
export class JevClient {
  private readonly gate: CooldownGate
  private readonly semaphore: Semaphore
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: JevClientOptions) {
    this.gate = new CooldownGate(options.failureThreshold, options.cooldownMs)
    this.semaphore = new Semaphore(options.maxConcurrency)
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? Date.now
  }

  /**
   * Ask Jev one batch of typed questions over one state.
   * @param call - attribution context, state, questions, and cancellation.
   * @returns the decision, or `null` when the call degraded (never throws).
   */
  async ask(
    call: JevCallContext & { state: unknown; questions: Readonly<Record<string, JevQuestion>> },
  ): Promise<JevDecision | null> {
    const started = this.now()
    const degrade = (reason: string) => {
      this.options.telemetry.record({
        ts: new Date().toISOString(),
        tag: call.tag,
        mode: call.mode,
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        ...(call.goalId === undefined ? {} : { goalId: call.goalId }),
        ...(call.round === undefined ? {} : { round: call.round }),
        verdict: 'uncertain',
        action: 'degraded',
        detail: reason,
        ...(reason === 'no-key' || reason === 'cooldown' ? {} : { latencyMs: this.now() - started }),
      })
      return null
    }
    const key = await this.options.resolveKey()
    if (key === undefined || key.length === 0) return degrade('no-key')
    if (this.gate.open()) return degrade('cooldown')
    if (call.signal?.aborted) return degrade('aborted')
    const acquired = await this.semaphore.acquire(
      call.signal ?? new AbortController().signal,
      this.options.timeoutMs - (this.now() - started),
    )
    if (acquired !== 'acquired') return degrade(acquired === 'aborted' ? 'aborted' : 'timeout')
    try {
      return await this.request(call, key, started)
    } finally {
      this.semaphore.release()
    }
  }

  /** The billable request loop: at most two attempts, second only for retryable statuses. */
  private async request(
    call: JevCallContext & { state: unknown; questions: Readonly<Record<string, JevQuestion>> },
    key: string,
    started: number,
  ): Promise<JevDecision | null> {
    const degrade = (reason: string) => {
      this.gate.failure()
      this.options.telemetry.record({
        ts: new Date().toISOString(),
        tag: call.tag,
        mode: call.mode,
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        ...(call.goalId === undefined ? {} : { goalId: call.goalId }),
        ...(call.round === undefined ? {} : { round: call.round }),
        verdict: 'uncertain',
        action: 'degraded',
        detail: reason,
        latencyMs: this.now() - started,
      })
      return null
    }
    for (let attempt = 1; ; attempt += 1) {
      const budget = this.options.timeoutMs - (this.now() - started)
      if (budget <= 0) return call.signal?.aborted ? degrade('caller-aborted') : degrade('timeout')
      const timer = AbortSignal.timeout(budget)
      const signal = call.signal === undefined ? timer : AbortSignal.any([call.signal, timer])
      let response: Response
      try {
        response = await this.fetchFn(this.options.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.options.model, state: call.state, questions: call.questions }),
          signal,
        })
      } catch (error) {
        if (call.signal?.aborted) return degrade('caller-aborted')
        if (timer.aborted || (error instanceof Error && error.name === 'AbortError')) return degrade('timeout')
        return degrade('http-error')
      }
      if (response.status === 429 || response.status === 529 || response.status >= 500) {
        if (attempt < 2 && this.options.timeoutMs - (this.now() - started) > 400) {
          try {
            await sleep(400, call.signal)
          } catch {
            return degrade('caller-aborted')
          }
          continue
        }
        return degrade(`http-${response.status}`)
      }
      if (!response.ok) return degrade(`http-${response.status}`)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return degrade('bad-json')
      }
      let answers: JevAnswers
      try {
        answers = parseAnswers(
          typeof body === 'object' && body !== null && 'answers' in body
            ? (body as { answers: unknown }).answers
            : undefined,
        )
      } catch {
        return degrade('parse-error')
      }
      this.gate.success()
      const usage = this.readUsage(body)
      const decision: JevDecision = {
        answers,
        model: this.readModel(body),
        latencyMs: this.now() - started,
        ...(usage === undefined ? {} : { inputTokens: usage, costUsd: estimateCostUsd(usage) }),
        cached: false,
      }
      return decision
    }
  }

  /** Best-effort `usage.input_tokens` extraction; absent usage is not an error. */
  private readUsage(body: unknown): number | undefined {
    if (typeof body !== 'object' || body === null || !('usage' in body)) return undefined
    const usage = (body as { usage: unknown }).usage
    if (typeof usage !== 'object' || usage === null || !('input_tokens' in usage)) return undefined
    const tokens = (usage as { input_tokens: unknown }).input_tokens
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined
  }

  /** Best-effort model identity extraction for telemetry. */
  private readModel(body: unknown): string {
    if (typeof body !== 'object' || body === null || !('model' in body)) return this.options.model
    const model = (body as { model: unknown }).model
    return typeof model === 'string' && model.length > 0 ? model : this.options.model
  }
}
