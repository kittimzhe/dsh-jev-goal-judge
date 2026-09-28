/**
 * Telemetry: one append-only JSONL log of every judged round plus the
 * `/jev-goal-stats` summary. Never throws — a telemetry failure is swallowed
 * because it must never change agent behavior.
 * @module dsh-jev-goal-judge/telemetry
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One telemetry record. `verdict`/`action` carry the judgment outcome. */
export interface TelemetryEntry {
  readonly ts: string
  readonly tag: string
  readonly mode: string
  readonly sessionId?: string
  readonly goalId?: string
  readonly round?: number
  readonly verdict: string
  readonly action: string
  readonly detail?: string
  readonly probabilities?: Readonly<Record<string, number>>
  readonly confidence?: number
  readonly latencyMs?: number
  readonly inputTokens?: number
  readonly costUsd?: number
  readonly cached?: boolean
  readonly steered?: boolean
}

/** Jev 1.13 published input price: $0.042 per million input tokens, output free. */
export const JEV_INPUT_USD_PER_MTOK = 0.042

/** Estimated input cost of a call, from its input token count. */
export function estimateCostUsd(inputTokens: number): number {
  return Math.round(((inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK + Number.EPSILON) * 1e8) / 1e8
}

/** Append-only JSONL telemetry log. */
export class Telemetry {
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, 'telemetry.jsonl')
  }

  /**
   * Append one record. Never throws: an unwritable log is dropped silently —
   * telemetry is observability, not a dependency.
   * @param entry - the record to persist.
   */
  record(entry: TelemetryEntry): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* swallowed by contract */
    }
  }

  /** Read every record from the log; an unreadable log reads as empty. */
  read(): TelemetryEntry[] {
    try {
      if (!existsSync(this.file)) return []
      return readFileSync(this.file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as TelemetryEntry]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  /** Render the human-readable stats summary shown by `/jev-goal-stats`. */
  stats(): string {
    const entries = this.read()
    if (entries.length === 0) return 'dsh-jev-goal-judge: no judgments recorded yet.'
    const judged = entries.filter((entry) => entry.action !== 'degraded')
    const degraded = entries.filter((entry) => entry.action === 'degraded')
    const steered = judged.filter((entry) => entry.steered === true)
    const byVerdict = new Map<string, number>()
    for (const entry of judged) byVerdict.set(entry.verdict, (byVerdict.get(entry.verdict) ?? 0) + 1)
    const latencies = judged
      .map((entry) => entry.latencyMs ?? undefined)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b)
    const tokens = judged.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0)
    const cost = judged.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
    const lines = [
      `[goal-judge] judgments: ${judged.length}  degraded: ${degraded.length}  steered: ${steered.length}`,
      `  verdicts: ${[...byVerdict.entries()].map(([verdict, count]) => `${verdict}=${count}`).join('  ')}`,
    ]
    if (latencies.length > 0) {
      const at = (fraction: number) => latencies[Math.min(latencies.length - 1, Math.floor(fraction * latencies.length))] ?? 0
      lines.push(`  latency: p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  max ${latencies[latencies.length - 1] ?? 0}ms`)
    }
    if (tokens > 0) lines.push(`  input tokens: ${tokens}  est. cost: $${cost.toFixed(6)}`)
    return lines.join('\n')
  }
}
