/**
 * dsh-jev-goal-judge — a Jev progress judgment between DeepSeek Harness goal
 * rounds.
 *
 * When a goal round's turn is about to close, one bounded Jev call judges the
 * round against the objective: achieved? evidenced? the same obstacle again?
 * In enforce mode a fixed-template nudge steers the agent back into the same
 * turn to verify-and-complete or report-blocked, so the goal-round driver
 * never queues a round that would only re-discover what the judge already
 * saw. Shadow mode (the default) records every judgment to telemetry and
 * steers nothing. Every degrade path — no key, cooldown, timeout, parse
 * mismatch, low confidence — leaves stock driver behavior untouched.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports load the cordis module augmentations that declare the
// `agents`/`goals`/`sessions`/`commands` services and the events this plugin
// listens to (`session/event`, `goal/changed`, `agent/*`).
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config, resolveSettings, type Settings } from './config.ts'
import { RoundObserver, type ObservedEvent } from './digest.ts'
import { buildJudgeQuestions, routeJudgment } from './judge.ts'
import { JevClient } from './jev.ts'
import { renderSteerNote, Steerer } from './steer.ts'
import { Telemetry } from './telemetry.ts'

export const name = 'jev-goal-judge'
export const inject = ['agents', 'goals', 'sessions']

export { Config, DEFAULTS, PROVIDER_PRESETS, resolveSettings } from './config.ts'
export type { ProviderName, Settings } from './config.ts'
export { RoundObserver, messageText } from './digest.ts'
export type { ObservedEvent } from './digest.ts'
export { buildJudgeQuestions, routeJudgment, lowProgressMass, ACTION_CONFIDENCE_FLOOR } from './judge.ts'
export { JevClient } from './jev.ts'
export type { JevCallContext, JevClientOptions, JevDecision } from './jev.ts'
export { renderSteerNote, Steerer } from './steer.ts'
export { Telemetry, estimateCostUsd, JEV_INPUT_USD_PER_MTOK } from './telemetry.ts'
export type { TelemetryEntry } from './telemetry.ts'
export {
  ACTION_OPTIONS,
  choice,
  noul,
  parseAnswers,
  PROGRESS_LEVELS,
  QUESTION_IDS,
  score,
} from './types.ts'
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  JevAnswer,
  JevAnswers,
  JevQuestion,
  Judgment,
  JudgeState,
  NoulAnswer,
  NoulQuestion,
  RoundDigest,
  ScoreAnswer,
  ScoreQuestion,
  ToolEntry,
  Verdict,
} from './types.ts'
export { CooldownGate, Semaphore } from './resilience.ts'

/** The `{kind:'plugin'}` source stamped on every note this plugin steers. */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'jev-goal-judge' } as const

/** Structural slice of the credentials seam (resolved defensively, never injected). */
interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined> | { value: string } | undefined
}

/** Structural slice of the launch-environment seam. */
interface LaunchEnvironmentLike {
  get(ref: string): string | undefined
}

/**
 * Resolve the provider key through the dsh credential plane: the credentials
 * seam when composed, then the launch environment, then ambient process env.
 * Structural on purpose — no hard dependency on the seam packages.
 */
function makeKeyResolver(ctx: Context, apiKeyEnv: string): () => Promise<string | undefined> {
  return async () => {
    const credentials = ctx.get('credentials') as CredentialsLike | undefined
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      // The seam owns the whole credential plane when present: a miss does not
      // fall through to ambient values (mirrors the llm-deepseek precedent).
      try {
        const hit = await credentials.resolve(apiKeyEnv)
        if (hit !== undefined && hit.value.length > 0) return hit.value
        return undefined
      } catch {
        return undefined
      }
    }
    const launchEnvironment = ctx.get('launchEnvironment') as LaunchEnvironmentLike | undefined
    if (launchEnvironment !== undefined && typeof launchEnvironment.get === 'function') {
      try {
        const value = launchEnvironment.get(apiKeyEnv)
        if (value !== undefined && value.length > 0) return value
        return undefined
      } catch {
        return undefined
      }
    }
    const ambient = process.env[apiKeyEnv]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }
}

/** Plugin entry: observe goal rounds, judge them at turn close, steer advisories. */
export function apply(ctx: Context, config?: Record<string, unknown>): void {
  const settings: Settings = resolveSettings(
    (config ?? {}) as Partial<Settings> & Record<string, unknown>,
    dshHomePath('dsh-jev-goal-judge'),
  )
  // Master opt-out: register nothing at all.
  if (!settings.enabled) return

  const telemetry = new Telemetry(settings.telemetryDir)
  const observer = new RoundObserver(settings)
  const steerer = new Steerer(settings)
  const client = new JevClient({
    endpoint: settings.endpoint,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    cooldownMs: settings.cooldownMs,
    failureThreshold: settings.failureThreshold,
    maxConcurrency: settings.maxConcurrency,
    resolveKey: makeKeyResolver(ctx, settings.apiKeyEnv),
    telemetry,
    logger: { warn: (message) => ctx.logger.warn(`dsh-jev-goal-judge: ${message}`) },
  })

  ctx.effect(
    function* () {
      /** The live goal, read fresh at decision time exactly like the driver reads it. */
      const activeGoal = (agent: Agent) => {
        try {
          const goal = ctx.goals.get(agent)
          if (goal === undefined) return undefined
          if (goal.phase !== 'active' || goal.activation !== 'armed') return undefined
          return goal
        } catch {
          return undefined
        }
      }

      ctx.on('session/event', (session, event) => {
        try {
          const agent = ctx.agents.get(session.id)
          // Same liveness guard the goal-round driver uses: only events of
          // the session the live agent owns are observed.
          if (agent === undefined || agent.session !== session) return
          observer.observe(agent, event)
        } catch {
          /* observation must never disturb the session */
        }
      })

      ctx.on('goal/changed', ({ agent, change }) => {
        try {
          const goalId = change.goal?.id
          if (goalId === undefined) return
          if (change.operation === 'create') {
            observer.reScopeGoal(agent, goalId)
            steerer.forget(goalId)
          }
          if (change.goal?.phase === 'complete' || change.goal?.phase === 'blocked') {
            steerer.forget(goalId)
          }
        } catch {
          /* ignored */
        }
      })

      ctx.on('agent/session-start', ({ agent }) => observer.reset(agent))
      ctx.on('agent/disposed', ({ agent }) => observer.reset(agent))

      ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        try {
          const target = observer.digestForTurn(agent, turn)
          if (target === undefined) return
          const goal = activeGoal(agent)
          if (goal === undefined) return
            const state = {
              objective: goal.objective,
              round: target.round,
              maxRounds: goal.maxGoalRounds,
              roundDigest: target.digest,
              previousFinals: target.previousFinals,
            }
            const decision = await client.ask({
              tag: 'goal-round',
              mode: settings.mode,
              sessionId: agent.session?.id,
              goalId: goal.id,
              round: target.round,
              signal,
              state,
              questions: buildJudgeQuestions(state),
            })
            if (decision === null) return
            const judgment = routeJudgment(decision.answers, settings, target.round)
            const note = renderSteerNote(judgment.verdict, target.round)
            const maySteer =
              settings.mode === 'enforce' &&
              note !== undefined &&
              judgment.verdict !== 'uncertain' &&
              steerer.allows(judgment.verdict, goal.id)
            if (maySteer) {
              steerer.spend(judgment.verdict, goal.id)
              agent.steer(
                createUserMessage({
                  content: [{ type: 'text', text: note }],
                  source: PLUGIN_SOURCE,
                }),
              )
            }
            telemetry.record({
              ts: new Date().toISOString(),
              tag: 'goal-round',
              mode: settings.mode,
              ...(agent.session?.id === undefined ? {} : { sessionId: agent.session.id }),
              goalId: goal.id,
              round: target.round,
              verdict: judgment.verdict,
              action: maySteer ? 'steered' : 'judged',
              detail: judgment.actionChoice,
              probabilities: {
                achieved: judgment.achieved ?? 0,
                evidence: judgment.evidence ?? 0,
                ...(judgment.sameObstacle === undefined ? {} : { sameObstacle: judgment.sameObstacle }),
                ...(judgment.lowProgressMass === undefined ? {} : { lowProgressMass: judgment.lowProgressMass }),
              },
              confidence: judgment.confidence,
              latencyMs: decision.latencyMs,
              ...(decision.inputTokens === undefined
                ? {}
                : { inputTokens: decision.inputTokens, costUsd: decision.costUsd }),
              cached: decision.cached,
              steered: maySteer,
            })
        } catch (error) {
          // Fail-open by construction: an exception here must never block
          // the turn close or disturb the goal driver.
          ctx.logger.warn(
            `dsh-jev-goal-judge: turn-stopping judge failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })

      // The stats command is optional: register it only when the commands
      // service composes, so minimal profiles can still run the judge.
      ctx.inject(['commands'], (commandsCtx) => {
        void commandsCtx.commands.register({
          name: 'jev-goal-stats',
          description: 'Show dsh-jev-goal-judge judgment statistics',
          handler: async () => ({ kind: 'success', text: telemetry.stats() }),
        })
      })

      ctx.logger.info(
        `dsh-jev-goal-judge: active in ${settings.mode} mode (provider endpoint ${settings.endpoint}, model ${settings.model})`,
      )

      yield () => {
        // Plugin-local state only: every listener registered on this scope is
        // disposed with it, so dropping the observer map is the whole cleanup.
        observer.resetAll()
      }
    },
    'jev-goal-judge lifecycle',
  )
}
