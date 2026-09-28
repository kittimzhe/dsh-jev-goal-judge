import { describe, expect, it } from 'vitest'
import { Config, DEFAULTS, PROVIDER_PRESETS, resolveSettings } from '../src/config.ts'

describe('config schema', () => {
  it('applies every default from an empty object', () => {
    const normalized = Config({}) as Record<string, unknown>
    expect(normalized['mode']).toBe(DEFAULTS.mode)
    expect(normalized['provider']).toBe(DEFAULTS.provider)
    expect(normalized['timeoutMs']).toBe(DEFAULTS.timeoutMs)
    expect(normalized['achievedMin']).toBe(DEFAULTS.achievedMin)
  })

  it('keeps explicit values', () => {
    const normalized = Config({ mode: 'enforce', timeoutMs: 2000 }) as Record<string, unknown>
    expect(normalized['mode']).toBe('enforce')
    expect(normalized['timeoutMs']).toBe(2000)
  })
})

describe('resolveSettings', () => {
  it('derives typesafe endpoint/model/key from the preset', () => {
    const settings = resolveSettings({ provider: 'typesafe' }, '/tmp/fallback')
    expect(settings.endpoint).toBe(PROVIDER_PRESETS.typesafe.endpoint)
    expect(settings.model).toBe('jev-latest')
    expect(settings.apiKeyEnv).toBe('TYPESAFE_API_KEY')
    expect(settings.telemetryDir).toBe('/tmp/fallback')
  })

  it('derives openrouter preset with the tilde model id', () => {
    const settings = resolveSettings({ provider: 'openrouter' }, '/tmp/fallback')
    expect(settings.endpoint).toBe(PROVIDER_PRESETS.openrouter.endpoint)
    expect(settings.model).toBe('~typesafe/jev-latest')
    expect(settings.apiKeyEnv).toBe('OPENROUTER_API_KEY')
  })

  it('explicit endpoint and model override the preset', () => {
    const settings = resolveSettings(
      { provider: 'typesafe', endpoint: 'https://local:9/', model: 'jev-1.13.0' },
      '/tmp/fallback',
    )
    expect(settings.endpoint).toBe('https://local:9/')
    expect(settings.model).toBe('jev-1.13.0')
    expect(settings.apiKeyEnv).toBe('TYPESAFE_API_KEY')
  })

  it('rejects custom provider without endpoint and model', () => {
    expect(() => resolveSettings({ provider: 'custom' }, '/tmp/fallback')).toThrow(/custom/)
  })

  it('accepts custom provider with explicit endpoint and model', () => {
    const settings = resolveSettings(
      { provider: 'custom', endpoint: 'https://laya.local/', model: 'laya' },
      '/tmp/fallback',
    )
    expect(settings.endpoint).toBe('https://laya.local/')
    expect(settings.model).toBe('laya')
  })
})
