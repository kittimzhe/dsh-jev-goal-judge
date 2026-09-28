import { describe, expect, it } from 'vitest'
import { renderSteerNote, Steerer } from '../src/steer.ts'

describe('renderSteerNote', () => {
  it('renders verify-complete with the round number and no dynamic text', () => {
    const note = renderSteerNote('verify-complete', 4)
    expect(note).toBeDefined()
    expect(note).toContain('round 4')
    expect(note).toContain('<goal_judge>')
    expect(note).toContain('</goal_judge>')
    expect(note).toContain('mark it complete now')
  })

  it('renders report-blocked with the round number', () => {
    const note = renderSteerNote('report-blocked', 3)
    expect(note).toBeDefined()
    expect(note).toContain('round 3')
    expect(note).toContain('materially different approach')
  })

  it('renders nothing for on-track and uncertain', () => {
    expect(renderSteerNote('on-track', 3)).toBeUndefined()
    expect(renderSteerNote('uncertain', 3)).toBeUndefined()
  })
})

describe('Steerer budgets', () => {
  it('allows steers only within the configured budgets', () => {
    const steerer = new Steerer({ verifyCompleteMax: 2, reportBlockedMax: 1 })
    expect(steerer.allows('verify-complete', 'g1')).toBe(true)
    steerer.spend('verify-complete', 'g1')
    steerer.spend('verify-complete', 'g1')
    expect(steerer.allows('verify-complete', 'g1')).toBe(false)
    expect(steerer.allows('report-blocked', 'g1')).toBe(true)
    steerer.spend('report-blocked', 'g1')
    expect(steerer.allows('report-blocked', 'g1')).toBe(false)
  })

  it('never allows non-steerable verdicts', () => {
    const steerer = new Steerer({ verifyCompleteMax: 2, reportBlockedMax: 1 })
    expect(steerer.allows('on-track', 'g1')).toBe(false)
    expect(steerer.allows('uncertain', 'g1')).toBe(false)
  })

  it('scopes budgets per goal and forget drops them', () => {
    const steerer = new Steerer({ verifyCompleteMax: 1, reportBlockedMax: 1 })
    steerer.spend('verify-complete', 'g1')
    expect(steerer.allows('verify-complete', 'g1')).toBe(false)
    expect(steerer.allows('verify-complete', 'g2')).toBe(true)
    steerer.forget('g2')
    expect(steerer.allows('verify-complete', 'g2')).toBe(true)
  })
})
