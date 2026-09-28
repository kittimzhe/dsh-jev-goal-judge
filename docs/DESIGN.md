# dsh-jev-goal-judge — Design

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts a
[Jev](https://typesafe.ai) (TypeSafe AI System One) progress judgment between goal rounds:
when a goal round's turn is about to close, one bounded Jev call decides whether the
objective looks achieved, stalled, or on track — and steers a typed nudge back into the
*same turn* when the evidence says the next round would be wasted.

## The pain point (source receipts)

`dsh-goal-round-driver` continues rounds **unconditionally**:

- `goal-round-driver/lib/index.js:125` — `if (goal.roundsStarted >= goal.maxGoalRounds)`
  is the *only* stop check; below the limit it always queues the next round.
- `dsh-goal/lib/index.js:189-205` — the blocked phase transition exists, but the
  model-facing tool policy demands the same blocker persist across **three** rounds
  before `blocked` is accepted, so a real blocker burns the budget.
- Nothing checks whether the work already done satisfies the objective: an agent that
  finishes the work but never calls `update_goal complete` donates a whole extra round
  (prompt + full turn) to re-discovering that fact.

Each wasted round is a full agent turn of tokens. This plugin's job is to make the
boundary between rounds a *measured* decision instead of a counter.

## Positioning

- **Judge, not gatekeeper.** v1 never mutates goal state (`ctx.goals` is read-only here):
  no `block`, no `pause`, no `complete`, no `disarm`. The only actuator is `agent.steer()`
  with a fixed-template advisory note. The agent and the human stay sovereign.
- **Shadow first.** Default mode records every judgment to telemetry and steers nothing.
  Enforce mode is opt-in, per the `dsh-jev-interceptor` rollout playbook.
- **Fail-open everywhere.** No key, cooldown, timeout, parse mismatch, or low confidence
  degrades to stock driver behavior. The plugin can shorten a goal; it can never extend,
  block, or widen one.

## Architecture

```
session/event stream ──► RoundObserver ──► per-agent round digest
                                                │
agent/turn-stopping (serial) ──────────────────►┤ goal active+armed? closing turn was round N≥1?
                                                ▼
                                          JevClient.classify()
                                          (one fan-out: 4-5 questions, ≤16k state chars)
                                                │ verdict: on-track | verify-complete | report-blocked | uncertain
                                                ▼
                          shadow: telemetry only   enforce: + agent.steer(<goal_judge> note)
                                                │
                                          /jev-goal-stats command reads telemetry.jsonl
```

### Why `agent/turn-stopping` is the seam

- It is the documented serial extension point for objecting to a turn close:
  "a listener that objects steers (`agent.steer(...)`) and the machine re-reads its
  inbox: fresh steering runs another step" (`dsh-agent/lib/types/runtime-types.d.ts`,
  `agent/turn-stopping`).
- It runs **before** the agent goes idle, and the goal-round-driver only queues the next
  round on `agent/status → idle`. No race, no ordering hazard.
- `steer()` submits to the **next-step** boundary, not `nextTurn`. The driver's
  competing-queue listener (`agent/inbox/inserted`) only flags `nextTurn` messages, so a
  judge note can never be mistaken for a human interjection and never pauses the goal.
- A steered extra step that ends in `update_goal complete` means the driver never queues
  round N+1 at all: **the whole round is saved**.

### RoundObserver (digest accumulator)

Listens to `session/event` and keeps per-agent bounded state:

| event | use |
|---|---|
| `user/message` with `source.kind === 'goal'` | round boundary: start digest for round `source.round` |
| `assistant/message` | append assistant text tail (bounded) |
| `tool/call` / `tool/result` | append `{name, ok}` entries (bounded count) |
| `turn/end` | close the digest window |
| `goal/change` | reset steer budgets on a fresh goal; drop state on terminal phases |

Reset entirely on `agent/session-start` and `agent/disposed`.

### Judge (one Jev fan-out per judged round-end)

`state` (JSON, bounded):

```jsonc
{
  "objective": "…", "round": 3, "maxRounds": 12,
  "roundDigest": {
    "assistantTail": "…≤6000 chars…",
    "tools": [{"name": "bash", "ok": true}, /* ≤40 */],
    "finalMessage": "…≤2000 chars…"
  },
  "previousFinals": ["…≤1500 chars each, ≤2…"]  // prior rounds' final assistant claims
}
```

`questions` (fixed instruction strings; transcript text lives only in `state`):

| id | type | asks |
|---|---|---|
| `achieved` | noul | the work reported in `roundDigest` satisfies the **whole** objective |
| `evidence` | noul | the digest shows concrete completion evidence (artifacts, passing checks), not only a claim |
| `progress` | score | levels `none / marginal / partial / substantial / complete` |
| `sameObstacle` | noul | *(only when `previousFinals` non-empty)* the obstacle in `finalMessage` is materially the same one described in `previousFinals` |
| `action` | choice | `continue` / `verify-complete` / `report-blocked`, with per-option judging notes |

### Verdict routing

| verdict | condition (defaults, all configurable) | enforce action |
|---|---|---|
| `verify-complete` | `achieved ≥ 0.75` **and** `evidence ≥ 0.6` | steer: verify against the objective; if confirmed, read the goal and mark it complete now; otherwise state precisely what remains |
| `report-blocked` | `sameObstacle ≥ 0.8` **and** low progress (`P(none)+P(marginal) ≥ 0.7`) **and** `round ≥ 2` | steer: either take a materially different approach this step, or report the goal blocked with the concrete condition |
| `on-track` | anything else | silence |
| `uncertain` | Jev degraded / parse mismatch / low confidence | silence (fail-open) |

Steer budgets (per goal): at most 2 `verify-complete` and 1 `report-blocked` nudges, so
the judge can never talk more than the round prompts it saves. Notes are fixed templates
parameterized only by round numbers — no model-generated text is echoed into prompts.

## Config (Schemastery)

```yaml
enabled: true            # master switch; false registers nothing
mode: shadow             # shadow | enforce
provider: typesafe       # typesafe | openrouter | custom
endpoint: ''             # derived from provider when empty
model: ''                # jev-latest / ~typesafe/jev-latest by provider
apiKeyEnv: TYPESAFE_API_KEY
timeoutMs: 1500
cooldownMs: 60000
failureThreshold: 3
maxConcurrency: 2
telemetryDir: ''         # default: dshHomePath('dsh-jev-goal-judge')
digest: { assistantTailChars: 6000, finalMessageChars: 2000, maxToolEntries: 40, previousFinals: 2, previousFinalChars: 1500 }
thresholds: { achievedMin: 0.75, evidenceMin: 0.6, sameObstacleMin: 0.8, lowProgressMass: 0.7, minRoundForBlocked: 2 }
steerBudget: { verifyCompleteMax: 2, reportBlockedMax: 1 }
```

## Telemetry

`<DSH_HOME>/dsh-jev-goal-judge/telemetry.jsonl`, one record per judged round:
`{ts, sessionId, goalId, round, mode, verdict, probabilities, confidence, latencyMs,
inputTokens, costUsd, cached, steered, detail?}`. `/jev-goal-stats` (registered only when
the `commands` service composes) prints counts per verdict, steers issued, degraded calls,
token/cost totals, and latency percentiles. Never throws; a telemetry failure is swallowed.

## Jev client (wire-verified)

- TypeSafe direct: `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`.
- OpenRouter: `POST https://openrouter.ai/api/alpha/decisions`, model `~typesafe/jev-latest`.
- Body `{model, state, questions}` → `answers` parsed strictly (noul/choice/score shapes
  per `dsh-jev-interceptor/lib/types.js` `parseAnswers`); any shape deviation is a
  degrade, never a guess.
- Cooldown gate after consecutive failures, one 429/529/5xx retry inside the remaining
  budget, concurrency semaphore. No cache: every round's state is unique.

## Non-goals (v1)

- No direct `ctx.goals` mutations (block/pause/complete/disarm) — advisory steering only.
- No round extension, no model routing, no compaction, no cross-goal memory.
- No free-form model text in steer notes — fixed templates only.

## Test plan (vitest, offline, no network)

1. **config** — schema defaults, provider endpoint/model derivation, normalization.
2. **digest** — synthetic `session/event` streams: round boundaries, bounding, goal-change
   resets, non-goal turns ignored.
3. **judge** — question construction (sameObstacle present/absent), routing table across
   the threshold grid, budget exhaustion, degraded → `uncertain`.
4. **jev** — payload shape, strict parsing, degrade paths (no-key, cooldown, timeout,
   429-then-success, 5xx, malformed body), concurrency, abort propagation.
5. **steer** — template rendering, budgets, shadow never steers, note source is
   `{kind:'plugin'}` (never nextTurn-competing).
6. **telemetry** — record/read/stats, unreadable log reads empty, cost estimate.
7. **wiring** — fake `ctx`: goal round end → judge mock → steer in enforce, silence in
   shadow and on degrade; listener registration and cleanup.

## Packaging

Follows `dsh-session-recall`: tsdown ESM build, `tsc --noEmit`, vitest, `dsh.bundle`
cordis patch for `dsh plugin --profile <name> add dsh-jev-goal-judge`, MIT, CI on push/PR.
Requires the `agents`, `goals`, `sessions` services (every shipped profile provides them);
`commands` is optional and resolved defensively.
