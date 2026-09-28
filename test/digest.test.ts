import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config.ts'
import { RoundObserver, type ObservedEvent } from '../src/digest.ts'

const settings = { ...DEFAULTS }

function goalRoundMessage(round: number) {
  return {
    type: 'user/message',
    data: { id: `u${round}`, role: 'user', source: { kind: 'goal', goalId: 'g1', revision: 1, round } },
  } satisfies ObservedEvent
}

function assistantMessage(text: string) {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  } satisfies ObservedEvent
}

function toolCall(callId: string, name: string) {
  return { type: 'tool/call', data: { callId, name, arguments: '{}' } } satisfies ObservedEvent
}

function toolResult(callId: string, ok: boolean) {
  return {
    type: 'tool/result',
    data: {
      message: { source: { kind: 'tool', callId } },
      ...(ok ? {} : { error: { name: 'Error', code: 'E_FAIL' } }),
    },
  } satisfies ObservedEvent
}

describe('RoundObserver', () => {
  it('builds a digest for a goal round turn', () => {
    const observer = new RoundObserver(settings)
    const agent = { id: 'a1' }
    observer.observe(agent, { type: 'turn/start', data: { turn: 7 } })
    observer.observe(agent, goalRoundMessage(1))
    observer.observe(agent, assistantMessage('Step one done.'))
    observer.observe(agent, toolCall('c1', 'bash'))
    observer.observe(agent, toolResult('c1', true))
    observer.observe(agent, toolCall('c2', 'edit'))
    observer.observe(agent, toolResult('c2', false))
    observer.observe(agent, assistantMessage('Round 1 finished the plan.'))
    const target = observer.digestForTurn(agent, 7)
    expect(target?.round).toBe(1)
    expect(target?.digest.assistantTail).toContain('Step one done.')
    expect(target?.digest.finalMessage).toBe('Round 1 finished the plan.')
    expect(target?.digest.tools).toEqual([
      { name: 'bash', ok: true },
      { name: 'edit', ok: false },
    ])
    expect(target?.previousFinals).toEqual([])
  })

  it('returns undefined for a turn that is not a goal round', () => {
    const observer = new RoundObserver(settings)
    const agent = { id: 'a1' }
    observer.observe(agent, { type: 'turn/start', data: { turn: 8 } })
    observer.observe(agent, {
      type: 'user/message',
      data: { id: 'u9', role: 'user', source: { kind: 'user' } },
    })
    observer.observe(agent, assistantMessage('A human interjection.'))
    expect(observer.digestForTurn(agent, 8)).toBeUndefined()
  })

  it('captures the previous round final into previousFinals when the next round opens', () => {
    const observer = new RoundObserver(settings)
    const agent = { id: 'a1' }
    observer.observe(agent, { type: 'turn/start', data: { turn: 1 } })
    observer.observe(agent, goalRoundMessage(1))
    observer.observe(agent, assistantMessage('Blocked on the API key missing.'))
    observer.observe(agent, { type: 'turn/start', data: { turn: 2 } })
    observer.observe(agent, goalRoundMessage(2))
    observer.observe(agent, assistantMessage('Still blocked on the API key.'))
    const target = observer.digestForTurn(agent, 2)
    expect(target?.round).toBe(2)
    expect(target?.previousFinals).toEqual(['Blocked on the API key missing.'])
  })

  it('bounds the assistant tail, tool entries, and previous finals', () => {
    const observer = new RoundObserver({
      ...settings,
      assistantTailChars: 500,
      finalMessageChars: 100,
      maxToolEntries: 5,
      previousFinals: 2,
      previousFinalChars: 50,
    })
    const agent = { id: 'a1' }
    observer.observe(agent, { type: 'turn/start', data: { turn: 1 } })
    observer.observe(agent, goalRoundMessage(1))
    for (let i = 0; i < 30; i += 1) {
      observer.observe(agent, toolCall(`c${i}`, `tool${i}`))
      observer.observe(agent, toolResult(`c${i}`, true))
      observer.observe(agent, assistantMessage(`line ${i} ${'x'.repeat(60)}`))
    }
    const first = observer.digestForTurn(agent, 1)
    expect(first?.digest.assistantTail.length).toBeLessThanOrEqual(500)
    expect(first?.digest.tools.length).toBe(5)
    for (let round = 2; round <= 4; round += 1) {
      observer.observe(agent, { type: 'turn/start', data: { turn: round } })
      observer.observe(agent, goalRoundMessage(round))
      observer.observe(agent, assistantMessage(`final of round ${round} ${'y'.repeat(80)}`))
    }
    const last = observer.digestForTurn(agent, 4)
    expect(last?.previousFinals.length).toBe(2)
    for (const final of last?.previousFinals ?? []) expect(final.length).toBeLessThanOrEqual(50)
  })

  it('drops state on reset and re-scope', () => {
    const observer = new RoundObserver(settings)
    const agent = { id: 'a1' }
    observer.observe(agent, { type: 'turn/start', data: { turn: 1 } })
    observer.observe(agent, goalRoundMessage(1))
    observer.observe(agent, assistantMessage('work'))
    observer.reScopeGoal(agent, 'g2')
    expect(observer.digestForTurn(agent, 1)).toBeUndefined()
    observer.observe(agent, { type: 'turn/start', data: { turn: 2 } })
    observer.observe(agent, goalRoundMessage(1))
    const target = observer.digestForTurn(agent, 2)
    expect(target?.previousFinals).toEqual([])
    observer.reset(agent)
    expect(observer.digestForTurn(agent, 2)).toBeUndefined()
  })

  it('ignores malformed events defensively', () => {
    const observer = new RoundObserver(settings)
    const agent = { id: 'a1' }
    expect(() => {
      observer.observe(agent, { type: 'turn/start' })
      observer.observe(agent, { type: 'user/message', data: { source: { kind: 'goal' } } })
      observer.observe(agent, { type: 'assistant/message', data: {} })
      observer.observe(agent, { type: 'tool/call', data: { callId: 3, name: 4 } })
      observer.observe(agent, { type: 'tool/result', data: { message: null } })
      observer.observe(agent, { type: 'unknown/event' })
    }).not.toThrow()
    expect(observer.digestForTurn(agent, 0)).toBeUndefined()
  })
})
