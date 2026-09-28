/**
 * Plugin configuration. Every deployment-varying choice is a schema field so
 * the profile's cordis patch can change it without a code edit. Defaults keep
 * the plugin observational (`mode: 'shadow'`): judgments are recorded, nothing
 * is steered, and stock goal-round behavior is untouched.
 * @module dsh-jev-goal-judge/config
 */
import z from '@deepseek-ai/schemastery'

/** TypeSafe direct decisions endpoint (System One). */
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
/** OpenRouter alpha decisions endpoint. */
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'

/** Provider presets: endpoint + model + default key environment variable. */
export const PROVIDER_PRESETS = {
  typesafe: {
    endpoint: TYPESAFE_ENDPOINT,
    model: 'jev-latest',
    apiKeyEnv: 'TYPESAFE_API_KEY',
  },
  openrouter: {
    endpoint: OPENROUTER_ENDPOINT,
    model: '~typesafe/jev-latest',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
} as const

export type ProviderName = keyof typeof PROVIDER_PRESETS

/**
 * Every default in one place: the schema references these for YAML loads, and
 * {@link resolveSettings} re-applies them for programmatic construction that
 * bypasses Schemastery normalization.
 */
export const DEFAULTS = {
  enabled: true,
  mode: 'shadow' as const,
  provider: 'typesafe' as ProviderName,
  endpoint: '',
  model: '',
  apiKeyEnv: '',
  timeoutMs: 1500,
  cooldownMs: 60_000,
  failureThreshold: 3,
  maxConcurrency: 2,
  telemetryDir: '',
  assistantTailChars: 6000,
  finalMessageChars: 2000,
  maxToolEntries: 40,
  previousFinals: 2,
  previousFinalChars: 1500,
  achievedMin: 0.75,
  evidenceMin: 0.6,
  sameObstacleMin: 0.8,
  lowProgressMass: 0.7,
  minRoundForBlocked: 2,
  verifyCompleteMax: 2,
  reportBlockedMax: 1,
} as const

/** The plugin-row config shape (mirrors the schema below, but a named type so
 * the exported schema's type stays portable across schemastery copies). */
export interface Config {
  enabled?: boolean
  mode?: 'shadow' | 'enforce'
  provider?: ProviderName | 'custom'
  endpoint?: string
  model?: string
  apiKeyEnv?: string
  timeoutMs?: number
  cooldownMs?: number
  failureThreshold?: number
  maxConcurrency?: number
  telemetryDir?: string
  assistantTailChars?: number
  finalMessageChars?: number
  maxToolEntries?: number
  previousFinals?: number
  previousFinalChars?: number
  achievedMin?: number
  evidenceMin?: number
  sameObstacleMin?: number
  lowProgressMass?: number
  minRoundForBlocked?: number
  verifyCompleteMax?: number
  reportBlockedMax?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  mode: z.union(['shadow', 'enforce'] as const).default(DEFAULTS.mode),
  provider: z.union(['typesafe', 'openrouter', 'custom'] as const).default(DEFAULTS.provider),
  endpoint: z.string().default(DEFAULTS.endpoint),
  model: z.string().default(DEFAULTS.model),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULTS.apiKeyEnv),
  timeoutMs: z.number().step(1).min(100).max(60_000).default(DEFAULTS.timeoutMs),
  cooldownMs: z.number().step(1).min(1000).max(3_600_000).default(DEFAULTS.cooldownMs),
  failureThreshold: z.number().step(1).min(1).max(20).default(DEFAULTS.failureThreshold),
  maxConcurrency: z.number().step(1).min(1).max(8).default(DEFAULTS.maxConcurrency),
  telemetryDir: z.string().default(DEFAULTS.telemetryDir),
  assistantTailChars: z.number().step(1).min(200).max(32_000).default(DEFAULTS.assistantTailChars),
  finalMessageChars: z.number().step(1).min(100).max(16_000).default(DEFAULTS.finalMessageChars),
  maxToolEntries: z.number().step(1).min(0).max(500).default(DEFAULTS.maxToolEntries),
  previousFinals: z.number().step(1).min(0).max(5).default(DEFAULTS.previousFinals),
  previousFinalChars: z.number().step(1).min(100).max(8000).default(DEFAULTS.previousFinalChars),
  achievedMin: z.number().min(0.5).max(1).default(DEFAULTS.achievedMin),
  evidenceMin: z.number().min(0.5).max(1).default(DEFAULTS.evidenceMin),
  sameObstacleMin: z.number().min(0.5).max(1).default(DEFAULTS.sameObstacleMin),
  lowProgressMass: z.number().min(0.5).max(1).default(DEFAULTS.lowProgressMass),
  minRoundForBlocked: z.number().step(1).min(1).max(10).default(DEFAULTS.minRoundForBlocked),
  verifyCompleteMax: z.number().step(1).min(0).max(10).default(DEFAULTS.verifyCompleteMax),
  reportBlockedMax: z.number().step(1).min(0).max(10).default(DEFAULTS.reportBlockedMax),
})

/** Normalized settings the runtime consumes (no optional fields left). */
export interface Settings {
  readonly enabled: boolean
  readonly mode: 'shadow' | 'enforce'
  readonly provider: ProviderName | 'custom'
  readonly endpoint: string
  readonly model: string
  readonly apiKeyEnv: string
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly failureThreshold: number
  readonly maxConcurrency: number
  readonly telemetryDir: string
  readonly assistantTailChars: number
  readonly finalMessageChars: number
  readonly maxToolEntries: number
  readonly previousFinals: number
  readonly previousFinalChars: number
  readonly achievedMin: number
  readonly evidenceMin: number
  readonly sameObstacleMin: number
  readonly lowProgressMass: number
  readonly minRoundForBlocked: number
  readonly verifyCompleteMax: number
  readonly reportBlockedMax: number
}

function firstNonEmpty(...values: readonly string[]): string {
  for (const value of values) if (value.length > 0) return value
  return ''
}

/**
 * Resolve raw config into complete settings: apply defaults, then derive the
 * endpoint/model/apiKeyEnv from the provider preset when the fields are empty.
 * A `custom` provider must name its own endpoint and model explicitly.
 * @param raw - schema-normalized config (or a partial programmatic object).
 * @param fallbackTelemetryDir - directory used when `telemetryDir` is empty.
 * @returns fully resolved settings.
 */
export function resolveSettings(
  raw: Partial<Settings> & Record<string, unknown>,
  fallbackTelemetryDir: string,
): Settings {
  const provider = (raw.provider ?? DEFAULTS.provider) as ProviderName | 'custom'
  const preset = provider === 'custom' ? undefined : PROVIDER_PRESETS[provider]
  if (provider === 'custom' && firstNonEmpty(String(raw.endpoint ?? ''), String(raw.model ?? '')) === '') {
    throw new Error("provider 'custom' requires explicit endpoint and model")
  }
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    mode: (raw.mode ?? DEFAULTS.mode) as 'shadow' | 'enforce',
    provider,
    endpoint: firstNonEmpty(String(raw.endpoint ?? ''), preset?.endpoint ?? ''),
    model: firstNonEmpty(String(raw.model ?? ''), preset?.model ?? ''),
    apiKeyEnv: firstNonEmpty(String(raw.apiKeyEnv ?? ''), preset?.apiKeyEnv ?? ''),
    timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
    cooldownMs: raw.cooldownMs ?? DEFAULTS.cooldownMs,
    failureThreshold: raw.failureThreshold ?? DEFAULTS.failureThreshold,
    maxConcurrency: raw.maxConcurrency ?? DEFAULTS.maxConcurrency,
    telemetryDir: firstNonEmpty(String(raw.telemetryDir ?? ''), fallbackTelemetryDir),
    assistantTailChars: raw.assistantTailChars ?? DEFAULTS.assistantTailChars,
    finalMessageChars: raw.finalMessageChars ?? DEFAULTS.finalMessageChars,
    maxToolEntries: raw.maxToolEntries ?? DEFAULTS.maxToolEntries,
    previousFinals: raw.previousFinals ?? DEFAULTS.previousFinals,
    previousFinalChars: raw.previousFinalChars ?? DEFAULTS.previousFinalChars,
    achievedMin: raw.achievedMin ?? DEFAULTS.achievedMin,
    evidenceMin: raw.evidenceMin ?? DEFAULTS.evidenceMin,
    sameObstacleMin: raw.sameObstacleMin ?? DEFAULTS.sameObstacleMin,
    lowProgressMass: raw.lowProgressMass ?? DEFAULTS.lowProgressMass,
    minRoundForBlocked: raw.minRoundForBlocked ?? DEFAULTS.minRoundForBlocked,
    verifyCompleteMax: raw.verifyCompleteMax ?? DEFAULTS.verifyCompleteMax,
    reportBlockedMax: raw.reportBlockedMax ?? DEFAULTS.reportBlockedMax,
  }
}
