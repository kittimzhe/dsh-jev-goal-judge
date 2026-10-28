# dsh-jev-goal-judge

[![CI](https://github.com/kittimzhe/dsh-jev-goal-judge/actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-jev-goal-judge.svg)](https://www.npmjs.com/package/dsh-jev-goal-judge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Jev](https://img.shields.io/badge/powered%20by-Jev%20%7C%20System%20One-ff6b35.svg)](https://typesafe.ai)

English | [中文](README.zh.md)

> **A Jev progress judgment between DeepSeek Harness goal rounds — for about two cents per thousand rounds.**
>
> dsh's goal-round driver continues rounds on a counter, not on evidence: `roundsStarted < maxGoalRounds` is the only stop check, and the tool policy lets a real blocker burn three full rounds before `blocked` is accepted. This plugin puts one bounded [Jev](https://typesafe.ai) typed-decision call at each round boundary: when a round's turn is about to close, the judge asks whether the objective looks achieved, evidenced, or stuck on the same obstacle — and in enforce mode steers a fixed-template nudge back into the **same turn**, so a round that would only re-discover what the judge already saw never runs.

**What it does, in one breath:** at `agent/turn-stopping` of every goal round, one Jev fan-out (`achieved`/`evidence` nouls + a `progress` score + a `sameObstacle` noul + an `action` choice, ≤16k chars of state, ~$0.00002) judges the closing round against the objective; a confident *achieved-and-evidenced* verdict steers *"verify and mark it complete now"*, a confident *same-obstacle-again* verdict steers *"report blocked or change approach"* — and everything else, including every error, timeout, cooldown, and low-confidence answer, stays silent and leaves stock driver behavior untouched.

## Why this exists

The goal-round driver is honest about its own loop (`dsh-goal-round-driver`):

| Stock behavior | Cost |
| --- | --- |
| `roundsStarted >= maxGoalRounds` is the **only** stop check | every round below the limit runs, unconditionally |
| The model-facing tool policy accepts `blocked` only after the **same blocker persists across three rounds** | a real blocker donates two extra full turns to proving it is boring |
| Nothing checks whether work already done satisfies the objective | an agent that finishes but never calls `update_goal complete` donates a whole round to re-discovering that |

Each wasted round is a full agent turn of tokens. This plugin makes the boundary between rounds a *measured* decision instead of a counter — the same System-1-over-rules move `dsh-jev-interceptor` made for tool-call gating, applied to the goal loop.

## How it works

```
session/event stream ──► RoundObserver ──► bounded per-round digest
                                                │
agent/turn-stopping (serial) ──────────────────►┤ goal active+armed? closing turn is round N≥1?
                                                ▼
                                          one Jev fan-out
                                                │ verdict: on-track | verify-complete | report-blocked | uncertain
                                                ▼
                          shadow: telemetry only   enforce: + agent.steer(<goal_judge> note)
                                                │
                                          /jev-goal-stats reads telemetry.jsonl
```

- **The seam.** `agent/turn-stopping` is the documented serial extension point for objecting to a turn close; it runs *before* the driver queues the next round on idle, so there is no race. `steer()` submits to the **next-step** boundary — the driver's competing-message listener only flags `nextTurn` inserts, so a judge note can never be mistaken for a human interjection and can never pause the goal.
- **The judge.** One call, five fixed questions. Instruction strings are constants; transcript text lives only in the `state` data field, so tool output can never rewrite what is being asked. Routing is deterministic: the noul thresholds decide, the `action` choice only breaks ties — a threshold change replays exactly over logged answers.
- **The savings.** A steered extra step that ends in `update_goal complete` means the driver never queues the next round at all: **the whole round is saved.** A steered *"report blocked"* that lands converts three rounds of blocker evidence into one.

## Safety model (the part you should actually read)

- **Judge, not gatekeeper.** v1 never mutates goal state — no `block`, no `pause`, no `complete`, no `disarm`. The only actuator is `agent.steer()` with a fixed-template advisory note. The agent and the human stay sovereign; the driver's own policies stay in force.
- **Fail-open everywhere.** No key, cooldown, timeout, parse mismatch, or sub-floor confidence degrades to stock behavior. The plugin can shorten a goal; it can never extend, block, or widen one.
- **Bounded by construction.** Assistant tail ≤ 6000 chars, final message ≤ 2000, tool entries ≤ 40, previous finals ≤ 2 × 1500 — comfortably inside Jev's 32k state budget. Provider limits: one retry on 429/529/5xx inside the remaining budget, cooldown after consecutive failures, concurrency cap.
- **Steer budgets.** At most 2 `verify-complete` and 1 `report-blocked` nudges per goal: the judge can never talk more than the rounds it saves. Notes are parameterized by round numbers only — no model- or Jev-generated text is ever echoed into a prompt.
- **Shadow first.** The default mode records every judgment to telemetry (`<DSH_HOME>/dsh-jev-goal-judge/telemetry.jsonl`) and steers nothing. Flip to `enforce` when the numbers earn it.

## The 60-second tour

```sh
dsh plugin --profile <name> add dsh-jev-goal-judge
```

```yaml
# in your profile's cordis.patch.yml (the bundle ships this as shadow mode)
- id: jev-goal-judge
  name: dsh-jev-goal-judge
  config:
    enabled: true
    mode: shadow            # watch mode first: every judgment lands in telemetry
    provider: typesafe      # or 'openrouter' (works today, no waitlist)
    apiKeyEnv: TYPESAFE_API_KEY
```

Use goals normally. In shadow mode every round boundary is judged and logged; `/jev-goal-stats` summarizes judgments, verdict distribution, latency percentiles, and cost.

First live judgment against the real API (smoke run, `provider: typesafe`, one fan-out):

```
answers (828ms, 763 input tokens, $0.000032):
  achieved (noul)   = 0.83
  evidence (noul)   = 0.90
  progress (score)  = 3.94 (confidence 0.95)
  action (choice)   = verify-complete (confidence 0.97)
  sameObstacle      = 0.15

verdict: verify-complete (confidence 0.95)
```

The scenario: round 3 of "ship the release" with tests passing, docs and changelog done, release tagged. Jev routed **verify-complete** — matching ground truth, with both gates cleared (achieved 0.83 ≥ 0.75, evidence 0.90 ≥ 0.6) — for $0.000032 in 828ms. Threshold changes replay exactly over logged answers, so this run can be re-audited at any future thresholds.

Happy with what shadow mode would have steered? Flip `mode: enforce`.

## Configure

Everything is a config field — timeouts, cooldown, concurrency, digest bounds, every threshold, steer budgets (see `Config` in `src/config.ts`). Notable defaults:

- `mode: shadow` — nothing is steered until you say so.
- `minRoundsForBlocked: 2` — the blocked nudge needs at least one prior round to compare.
- `verifyCompleteMax: 2`, `reportBlockedMax: 1` — the per-goal steer budgets.
- Provider endpoints: TypeSafe direct (`api.typesafe.ai/v1/systemone`, model `jev-latest`) or OpenRouter (`openrouter.ai/api/alpha/decisions`, model `~typesafe/jev-latest`). The key resolves through the dsh credential seam (`~/.dsh/.credentials.yaml`), then the launch environment, then ambient env.

## Cost

Jev 1.13: $0.042 per million input tokens, output free. A judgment call carries 500–2000 input tokens, once per **round** (not per tool call): **~$0.00002–0.00008 per round**. A 12-round goal costs less than a thousandth of a dollar to judge end to end.

## What this plugin deliberately does not do

- No direct `ctx.goals` mutations — advisory steering only, v1 and by default.
- No round extension, model routing, compaction, or cross-goal memory — one seam, done properly.
- No free-form generated text in steer notes — fixed templates, round numbers only.

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck            # src + tests against real @deepseek-ai types
npm test                     # vitest, 53 tests, no network
npm run bundle               # tsdown -> lib/
```

The full design — seam analysis, question set, routing table, safety model — is in [`docs/DESIGN.md`](docs/DESIGN.md).

## License

MIT
