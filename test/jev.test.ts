import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, resolveSettings, type Settings } from '../src/config.ts'
import { JevClient } from '../src/jev.ts'
import { Telemetry, type TelemetryEntry } from '../src/telemetry.ts'
import { parseAnswers } from '../src/types.ts'

const settings: Settings = { ...DEFAULTS, telemetryDir: '/tmp/unused' }

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Fresh telemetry dir so JSONL state never leaks across tests or runs. */
function freshTelemetry(): Telemetry {
  const dir = mkdtempSync(join(tmpdir(), 'goal-judge-jev-'))
  tempDirs.push(dir)
  return new Telemetry(dir)
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    answers: {
      achieved: { type: 'noul', noul: 0.9 },
      evidence: { type: 'noul', noul: 0.9 },
      progress: {
        type: 'score',
        score: 4,
        confidence: 0.9,
        probabilities: { none: 0.01, marginal: 0.01, partial: 0.08, substantial: 0.2, complete: 0.7 },
      },
      action: { type: 'choice', choice: 'continue', probabilities: { continue: 0.95 }, confidence: 0.95 },
    },
    model: 'jev-latest',
    usage: { input_tokens: 512 },
    ...overrides,
  }
}

function makeClient(fetchFn: typeof fetch, telemetry: Telemetry = freshTelemetry()) {
  return new JevClient({
    endpoint: 'https://provider.test/decisions',
    model: '~typesafe/jev-latest',
    timeoutMs: 1500,
    cooldownMs: 60_000,
    failureThreshold: 3,
    maxConcurrency: 2,
    resolveKey: async () => 'test-key',
    telemetry,
    logger: { warn: () => {} },
    fetchFn,
    now: () => 0,
  })
}

describe('parseAnswers', () => {
  it('parses the three answer types strictly', () => {
    const answers = parseAnswers(okBody().answers)
    expect(answers['achieved']).toEqual({ type: 'noul', noul: 0.9 })
    expect(answers['action']).toEqual({
      type: 'choice',
      choice: 'continue',
      probabilities: { continue: 0.95 },
      confidence: 0.95,
    })
    expect(answers['progress']?.type).toBe('score')
  })

  it('rejects malformed members', () => {
    expect(() => parseAnswers({ bad: { type: 'noul', noul: 1.5 } })).toThrow()
    expect(() => parseAnswers({ bad: { type: 'mystery' } })).toThrow()
    expect(() => parseAnswers('nope')).toThrow()
    expect(() => parseAnswers(undefined)).toThrow()
  })
})

describe('JevClient.ask', () => {
  it('sends the typed wire payload and parses the answers', async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined
    const client = makeClient(async (url, init) => {
      captured = { url: String(url), init }
      return new Response(JSON.stringify(okBody()), { status: 200 })
    })
    const decision = await client.ask({
      tag: 'goal-round',
      mode: 'shadow',
      state: { objective: 'x' },
      questions: { achieved: { type: 'noul', instructions: 'done?' } },
    })
    expect(decision).not.toBeNull()
    expect(decision?.answers['achieved']).toEqual({ type: 'noul', noul: 0.9 })
    expect(decision?.inputTokens).toBe(512)
    expect(decision?.costUsd).toBeCloseTo(0.0000215, 8)
    expect(captured?.url).toBe('https://provider.test/decisions')
    const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>
    expect(body['model']).toBe('~typesafe/jev-latest')
    expect(body['state']).toEqual({ objective: 'x' })
    expect(body['questions']).toEqual({ achieved: { type: 'noul', instructions: 'done?' } })
    expect((captured?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer test-key')
  })

  it('degrades to null without a key and records the reason', async () => {
    const telemetry = freshTelemetry()
    const records: TelemetryEntry[] = []
    telemetry.record = (entry) => { records.push(entry) }
    const client = new JevClient({
      endpoint: 'https://provider.test/decisions',
      model: 'm',
      timeoutMs: 1500,
      cooldownMs: 60_000,
      failureThreshold: 3,
      maxConcurrency: 2,
      resolveKey: async () => undefined,
      telemetry,
      logger: { warn: () => {} },
    })
    const decision = await client.ask({ tag: 'goal-round', mode: 'shadow', state: {}, questions: {} })
    expect(decision).toBeNull()
    expect(records[0]?.detail).toBe('no-key')
  })

  it('retries a 429 once inside the budget and succeeds', async () => {
    let calls = 0
    const client = makeClient(async () => {
      calls += 1
      if (calls === 1) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify(okBody()), { status: 200 })
    })
    const decision = await client.ask({ tag: 'goal-round', mode: 'shadow', state: {}, questions: {} })
    expect(calls).toBe(2)
    expect(decision).not.toBeNull()
  })

  it('degrades on a persistent 5xx and opens the cooldown after streak', async () => {
    const telemetry = freshTelemetry()
    const client = new JevClient({
      endpoint: 'https://provider.test/decisions',
      model: 'm',
      timeoutMs: 1500,
      cooldownMs: 60_000,
      failureThreshold: 3,
      maxConcurrency: 2,
      resolveKey: async () => 'test-key',
      telemetry,
      logger: { warn: () => {} },
      fetchFn: async () => new Response('boom', { status: 503 }),
    })
    for (let i = 0; i < 3; i += 1) {
      const decision = await client.ask({ tag: 'goal-round', mode: 'shadow', state: {}, questions: {} })
      expect(decision).toBeNull()
    }
    const decision = await client.ask({ tag: 'goal-round', mode: 'shadow', state: {}, questions: {} })
    expect(decision).toBeNull()
    // The fourth call degraded via cooldown, not another HTTP failure.
    const entries = telemetry.read()
    const cooldown = entries.filter((entry) => entry.detail === 'cooldown')
    expect(cooldown.length).toBe(1)
    expect(entries.filter((entry) => entry.detail === 'http-503').length).toBe(3)
  })

  it('degrades on unparseable bodies', async () => {
    const client = makeClient(async () => new Response(JSON.stringify({ answers: { weird: { type: 'nope' } } }), { status: 200 }))
    const decision = await client.ask({ tag: 'goal-round', mode: 'shadow', state: {}, questions: {} })
    expect(decision).toBeNull()
  })

  it('degrades on network errors', async () => {
    const client = makeClient(async () => {
      throw new TypeError('fetch failed')
    })
    const decision = await client.ask({ tag: 'goal-round', mode: 'shadow', state: {}, questions: {} })
    expect(decision).toBeNull()
  })

  it('degrades on caller abort without counting a failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = makeClient(async () => new Response(JSON.stringify(okBody()), { status: 200 }))
    const decision = await client.ask({
      tag: 'goal-round',
      mode: 'shadow',
      state: {},
      questions: {},
      signal: controller.signal,
    })
    expect(decision).toBeNull()
  })
})
