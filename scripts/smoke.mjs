#!/usr/bin/env node
/**
 * scripts/smoke.mjs — one real judgment call against a live provider.
 *
 * Exercises the plugin's exact production path: the real question fan-out
 * (buildJudgeQuestions), the real client (JevClient, with cooldown/retry),
 * and the real routing (routeJudgment) over a synthetic goal round. Prints
 * the answers and the verdict; exits 0 when the provider answered and 1 when
 * the call degraded (no key, cooldown, timeout, parse mismatch).
 *
 * The key is read from, in order:
 *   1. --key <value>        (explicit; never logged)
 *   2. TYPESAFE_API_KEY / OPENROUTER_API_KEY environment variables
 *   3. the refs: block of ~/.dsh/.credentials.yaml (the dsh credential seam)
 *
 * Usage:
 *   node scripts/smoke.mjs                            # provider: typesafe
 *   node scripts/smoke.mjs --provider openrouter
 *   node scripts/smoke.mjs --key <key> --provider openrouter
 *
 * @module dsh-jev-goal-judge/scripts/smoke
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULTS,
  JevClient,
  PROVIDER_PRESETS,
  buildJudgeQuestions,
  resolveSettings,
  routeJudgment,
} from '../lib/index.js'

const args = process.argv.slice(2)
function argValue(name) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const provider = argValue('provider') ?? 'typesafe'
const explicitKey = argValue('key')

/** Read a ref name from the dsh credentials file without any YAML dependency. */
function credentialRef(name) {
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = text.match(new RegExp(`^  ${name}:\\s*(\\S+)\\s*$`, 'm'))
    return match?.[1]
  } catch {
    return undefined
  }
}

const preset = PROVIDER_PRESETS[provider]
if (preset === undefined) {
  console.error(`unknown provider "${provider}" (expected typesafe or openrouter)`)
  process.exit(1)
}
const key =
  explicitKey ??
  process.env[preset.apiKeyEnv] ??
  credentialRef(preset.apiKeyEnv) ??
  (provider === 'openrouter' ? credentialRef('TYPESAFE_API_KEY') : undefined)

const settings = resolveSettings({ provider }, join(homedir(), '.dsh', 'dsh-jev-goal-judge'))
const state = {
  objective: 'Ship the release: all tests pass, README updated, changelog written',
  round: 3,
  maxRounds: 12,
  roundDigest: {
    round: 3,
    assistantTail:
      'Ran the full test suite: 53 passed. Updated README with the new config table and rewrote the changelog entry. Tagged v0.1.0 locally.',
    tools: [
      { name: 'bash', ok: true },
      { name: 'edit', ok: true },
      { name: 'bash', ok: true },
    ],
    finalMessage: 'Tests pass, docs are updated, and the release is tagged. Nothing remains.',
  },
  previousFinals: ['Round 2 finished the config work; release notes still pending.'],
}
const questions = buildJudgeQuestions(state)

console.log(`provider:   ${provider}`)
console.log(`endpoint:   ${settings.endpoint}`)
console.log(`model:      ${settings.model}`)
console.log(`key source: ${explicitKey !== undefined ? '--key' : key !== undefined ? 'credentials/env' : 'NONE'}`)
console.log(`questions:  ${Object.keys(questions).join(', ')}\n`)

const client = new JevClient({
  endpoint: settings.endpoint,
  model: settings.model,
  timeoutMs: 10_000,
  cooldownMs: 0,
  failureThreshold: 3,
  maxConcurrency: 1,
  resolveKey: () => key,
  telemetry: { record: (entry) => console.error(`[telemetry] ${entry.action}: ${entry.detail ?? entry.verdict}`) },
  logger: { warn: (message) => console.error(`[warn] ${message}`) },
})

const started = Date.now()
const decision = await client.ask({
  tag: 'smoke',
  mode: 'shadow',
  goalId: 'smoke-goal',
  round: state.round,
  signal: AbortSignal.timeout(15_000),
  state,
  questions,
})

if (decision === null) {
  console.error('\nDEGRADED — the provider did not answer. Check the key, credits, or network.')
  process.exit(1)
}

console.log(`answers (${decision.latencyMs}ms, ${decision.inputTokens ?? '?'} input tokens, $${(decision.costUsd ?? 0).toFixed(8)}):`)
for (const [id, answer] of Object.entries(decision.answers)) {
  if (answer.type === 'noul') console.log(`  ${id} (noul)   = ${answer.noul}`)
  else if (answer.type === 'choice')
    console.log(`  ${id} (choice) = ${answer.choice} (confidence ${answer.confidence})`)
  else console.log(`  ${id} (score)  = ${answer.score} (confidence ${answer.confidence})`)
}

const judgment = routeJudgment(decision.answers, settings, state.round)
console.log(`\nverdict:    ${judgment.verdict} (confidence ${judgment.confidence.toFixed(2)})`)
console.log(`would steer in enforce mode: ${judgment.verdict === 'verify-complete' || judgment.verdict === 'report-blocked'}`)
console.log(`\nwall clock: ${Date.now() - started}ms`)
process.exit(0)
