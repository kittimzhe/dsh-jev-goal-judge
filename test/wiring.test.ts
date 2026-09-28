import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

/** Fresh telemetry dir per apply so tests never touch the real DSH_HOME. */
function telemetryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goal-judge-wiring-'))
  dirs.push(dir)
  return dir
}

/** Minimal cordis-shaped context: records listeners so tests can dispatch. */
interface RecordedListener {
  event: string
  listener: (...args: never[]) => unknown
}

class FakeContext {
  readonly listeners: RecordedListener[] = []
  readonly steered: unknown[] = []
  readonly injected: string[][] = []
  readonly logs: string[] = []
  goal = {
    id: 'g1',
    revision: 1,
    phase: 'active',
    activation: 'armed',
    objective: 'Ship the release with passing tests',
    maxGoalRounds: 12,
    roundsStarted: 2,
  }
  readonly agent = {
    id: 'agent-1',
    session: { id: 'sess-1' },
    steer: (message: unknown) => {
      this.steered.push(message)
    },
  }

  readonly effect = (generator: () => Generator<unknown>) => {
    // Drive the effect generator to completion so listeners register.
    const iterator = generator()
    let result = iterator.next()
    while (!result.done) result = iterator.next()
  }

  readonly on = (event: string, listener: (...args: never[]) => unknown) => {
    this.listeners.push({ event, listener })
    return () => {}
  }

  readonly inject = (deps: string[], callback: (ctx: unknown) => void) => {
    this.injected.push(deps)
  }

  readonly get = (name: string): unknown => {
    if (name === 'credentials' || name === 'launchEnvironment') return undefined
    return undefined
  }

  readonly goals = {
    get: (agent: unknown) => (agent === this.agent ? this.goal : undefined),
  }

  readonly agents = {
    get: (id: unknown) => (id === 'sess-1' ? this.agent : undefined),
  }

  readonly logger = {
    info: (message: string) => this.logs.push(message),
    warn: (message: string) => this.logs.push(message),
  }

  /** Dispatch one event to every matching listener. */
  async dispatch(event: string, ...args: unknown[]): Promise<void> {
    for (const record of this.listeners.filter((record) => record.event === event)) {
      await record.listener(...(args as never[]))
    }
  }
}

function goalRoundUserMessage(round: number) {
  return {
    id: `goal-round-${round}`,
    role: 'user',
    content: [{ type: 'text', text: `<goal_round>Round ${round}</goal_round>` }],
    source: { kind: 'goal', goalId: 'g1', revision: 1, round },
  }
}

function assistantMessage(text: string) {
  return { message: { content: [{ type: 'text', text }] } }
}

/** Drive one full goal round through the wired plugin. */
async function runRound(
  ctx: FakeContext,
  fetchFn: typeof fetch,
  options: { mode: 'shadow' | 'enforce'; round: number },
) {
  process.env['JEV_TEST_KEY'] = 'key-value'
  const calls: { body: unknown }[] = []
  // Patch fetch BEFORE apply: JevClient captures the module-level fetch at
  // construction time, so the mock must already be in place.
  const wrappedFetch: typeof fetch = async (url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)) })
    return fetchFn(url, init)
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = wrappedFetch as typeof fetch
  try {
    apply(ctx as unknown as Parameters<typeof apply>[0], {
      enabled: true,
      mode: options.mode,
      provider: 'custom',
      endpoint: 'https://provider.test/decisions',
      model: 'jev-test',
      apiKeyEnv: 'JEV_TEST_KEY',
      timeoutMs: 1500,
      telemetryDir: telemetryDir(),
    })
    const session = ctx.agent.session
    await ctx.dispatch('session/event', session, { type: 'turn/start', data: { turn: 10 } })
    await ctx.dispatch('session/event', session, { type: 'user/message', data: goalRoundUserMessage(options.round) })
    await ctx.dispatch('session/event', session, { type: 'assistant/message', data: assistantMessage('All tests pass; release shipped.') })
    await ctx.dispatch('session/event', session, {
      type: 'tool/call',
      data: { callId: 'c1', name: 'bash', arguments: '{}' },
    })
    await ctx.dispatch('session/event', session, {
      type: 'tool/result',
      data: { message: { source: { kind: 'tool', callId: 'c1' } } },
    })
    await ctx.dispatch('agent/turn-stopping', { agent: ctx.agent, turn: 10, signal: new AbortController().signal })
  } finally {
    globalThis.fetch = originalFetch
  }
  return calls
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env['JEV_TEST_KEY']
})

describe('plugin wiring', () => {
  it('judges a goal round in shadow mode without steering', async () => {
    const ctx = new FakeContext()
    const calls = await runRound(ctx, async () => new Response(JSON.stringify({
      answers: {
        achieved: { type: 'noul', noul: 0.95 },
        evidence: { type: 'noul', noul: 0.9 },
        progress: { type: 'score', score: 4, confidence: 0.9, probabilities: { none: 0.01, marginal: 0.01, partial: 0.08, substantial: 0.2, complete: 0.7 } },
        action: { type: 'choice', choice: 'verify-complete', probabilities: {}, confidence: 0.9 },
      },
      model: 'jev-test',
      usage: { input_tokens: 400 },
    }), { status: 200 }), { mode: 'shadow', round: 2 })
    expect(calls.length).toBe(1)
    const body = calls[0]?.body as Record<string, unknown>
    expect((body['state'] as Record<string, unknown>)['objective']).toBe('Ship the release with passing tests')
    expect((body['questions'] as Record<string, unknown>)['achieved']).toBeDefined()
    expect(ctx.steered.length).toBe(0)
  })

  it('steers a verify-complete nudge in enforce mode', async () => {
    const ctx = new FakeContext()
    await runRound(ctx, async () => new Response(JSON.stringify({
      answers: {
        achieved: { type: 'noul', noul: 0.95 },
        evidence: { type: 'noul', noul: 0.9 },
        progress: { type: 'score', score: 4, confidence: 0.9, probabilities: { none: 0.01, marginal: 0.01, partial: 0.08, substantial: 0.2, complete: 0.7 } },
        action: { type: 'choice', choice: 'verify-complete', probabilities: {}, confidence: 0.9 },
      },
    }), { status: 200 }), { mode: 'enforce', round: 2 })
    expect(ctx.steered.length).toBe(1)
    const message = ctx.steered[0] as {
      role: string
      content: Array<{ type: string; text: string }>
      source: { kind: string; plugin: string }
    }
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'jev-goal-judge' })
    expect(message.content[0]?.text).toContain('<goal_judge>')
    expect(message.content[0]?.text).toContain('round 2')
  })

  it('never steers when the judge degrades', async () => {
    const ctx = new FakeContext()
    await runRound(ctx, async () => new Response('boom', { status: 503 }), { mode: 'enforce', round: 2 })
    expect(ctx.steered.length).toBe(0)
    // Only the startup info line — no warnings leaked into the host log beyond
    // the provider-cooldown notice, which is expected exactly once.
    expect(ctx.logs.filter((line) => line.includes('judge failed')).length).toBe(0)
  })

  it('does not judge a turn that is not a goal round', async () => {
    const ctx = new FakeContext()
    process.env['JEV_TEST_KEY'] = 'key-value'
    apply(ctx as unknown as Parameters<typeof apply>[0], {
      enabled: true,
      mode: 'enforce',
      provider: 'custom',
      endpoint: 'https://provider.test/decisions',
      model: 'jev-test',
      apiKeyEnv: 'JEV_TEST_KEY',
      telemetryDir: telemetryDir(),
    })
    const session = ctx.agent.session
    await ctx.dispatch('session/event', session, { type: 'turn/start', data: { turn: 11 } })
    await ctx.dispatch('session/event', session, {
      type: 'user/message',
      data: { id: 'human-1', role: 'user', content: [], source: { kind: 'user' } },
    })
    let fetched = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetched = true
      return new Response('{}')
    }) as typeof fetch
    try {
      await ctx.dispatch('agent/turn-stopping', { agent: ctx.agent, turn: 11, signal: new AbortController().signal })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetched).toBe(false)
    expect(ctx.steered.length).toBe(0)
  })

  it('does not judge when the goal is not active and armed', async () => {
    const ctx = new FakeContext()
    ctx.goal = { ...ctx.goal, phase: 'paused' }
    await runRound(ctx, async () => new Response('{}', { status: 200 }), { mode: 'enforce', round: 2 })
    expect(ctx.steered.length).toBe(0)
  })

  it('registers nothing when disabled', () => {
    const ctx = new FakeContext()
    apply(ctx as unknown as Parameters<typeof apply>[0], { enabled: false })
    expect(ctx.listeners.length).toBe(0)
    expect(ctx.injected.length).toBe(0)
  })

  it('registers the stats command through optional inject', () => {
    const ctx = new FakeContext()
    process.env['JEV_TEST_KEY'] = 'key-value'
    apply(ctx as unknown as Parameters<typeof apply>[0], {
      enabled: true,
      mode: 'shadow',
      provider: 'custom',
      endpoint: 'https://provider.test/decisions',
      model: 'jev-test',
      apiKeyEnv: 'JEV_TEST_KEY',
      telemetryDir: telemetryDir(),
    })
    expect(ctx.injected).toContainEqual(['commands'])
  })
})
