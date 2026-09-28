import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateCostUsd, Telemetry, type TelemetryEntry } from '../src/telemetry.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'goal-judge-telemetry-'))
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function entry(overrides: Partial<TelemetryEntry> = {}): TelemetryEntry {
  return {
    ts: '2026-09-28T00:00:00.000Z',
    tag: 'goal-round',
    mode: 'shadow',
    verdict: 'on-track',
    action: 'judged',
    ...overrides,
  }
}

describe('estimateCostUsd', () => {
  it('prices input tokens at the published Jev rate', () => {
    expect(estimateCostUsd(1_000_000)).toBeCloseTo(0.042, 6)
    expect(estimateCostUsd(500)).toBeCloseTo(0.000021, 8)
    expect(estimateCostUsd(0)).toBe(0)
  })
})

describe('Telemetry', () => {
  it('round-trips records through the JSONL log', () => {
    const dir = tempDir()
    dirs.push(dir)
    const telemetry = new Telemetry(dir)
    telemetry.record(entry({ round: 1, verdict: 'on-track' }))
    telemetry.record(entry({ round: 2, verdict: 'verify-complete', steered: true }))
    const read = telemetry.read()
    expect(read.length).toBe(2)
    expect(read[1]?.verdict).toBe('verify-complete')
    expect(read[1]?.steered).toBe(true)
  })

  it('reads an empty or missing log as empty', () => {
    const dir = tempDir()
    dirs.push(dir)
    expect(new Telemetry(dir).read()).toEqual([])
  })

  it('skips corrupt lines when reading', () => {
    const dir = tempDir()
    dirs.push(dir)
    const telemetry = new Telemetry(dir)
    telemetry.record(entry({ round: 1 }))
    // Corrupt the log with a bad line plus a good one.
    appendFileSync(join(dir, 'telemetry.jsonl'), 'not json\n', 'utf8')
    telemetry.record(entry({ round: 2 }))
    const read = telemetry.read()
    expect(read.length).toBe(2)
  })

  it('never throws when the directory is unwritable', () => {
    const telemetry = new Telemetry('/dev/full/nope')
    expect(() => telemetry.record(entry())).not.toThrow()
  })

  it('summarizes stats across verdicts, steers, latency, and cost', () => {
    const dir = tempDir()
    dirs.push(dir)
    const telemetry = new Telemetry(dir)
    telemetry.record(entry({ verdict: 'on-track', latencyMs: 100, inputTokens: 500, costUsd: 0.000021 }))
    telemetry.record(entry({ verdict: 'verify-complete', action: 'steered', steered: true, latencyMs: 300, inputTokens: 500, costUsd: 0.000021 }))
    telemetry.record(entry({ action: 'degraded', verdict: 'uncertain', detail: 'timeout', latencyMs: 1500 }))
    const stats = telemetry.stats()
    expect(stats).toContain('judgments: 2')
    expect(stats).toContain('degraded: 1')
    expect(stats).toContain('steered: 1')
    expect(stats).toContain('on-track=1')
    expect(stats).toContain('verify-complete=1')
    expect(stats).toContain('input tokens: 1000')
  })

  it('reports no judgments for a fresh log', () => {
    const dir = tempDir()
    dirs.push(dir)
    expect(new Telemetry(dir).stats()).toContain('no judgments recorded yet')
  })
})
