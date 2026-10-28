# Add dsh-jev-goal-judge to Agent Decisions

One entry, one category (Agent Decisions — Jev supplies the decision step inside the agentic loop: goal-round continuation).

## The project

[dsh-jev-goal-judge](https://github.com/kittimzhe/dsh-jev-goal-judge) is a DeepSeek Harness plugin that judges each autonomous goal round at the `agent/turn-stopping` seam — before the goal-round driver queues the next round — with a single Jev fan-out:

- `Noul` — objective achieved
- `Noul` — decisive evidence present in transcript
- `Score` — progress this round (none / marginal / partial / substantial / complete)
- `Noul` — same obstacle as previous rounds (asked when prior finals exist)
- `Choice` — continue / verify-complete / report-blocked

Routing is deterministic over the probabilities (verify-complete gates at achieved ≥ 0.75 and evidence ≥ 0.6; report-blocked needs round ≥ 2, sameObstacle ≥ 0.8, and P(none)+P(marginal) ≥ 0.7), so threshold changes replay exactly over logged answers. In enforce mode it steers a fixed-template nudge back into the same turn via the harness `steer()` seam — budgeted at 2 verify-complete + 1 report-blocked per goal — and never mutates goal state itself. Shadow mode is the default; every degrade path (no key, timeout, cooldown, parse mismatch) fails open to native behavior.

## Compliance notes

- **Depth**: the repository performs the typed decision it claims (real System One wire client with strict answer parsing), ships 53 runnable offline tests that fail if the logic breaks, and is installable end-to-end via `dsh plugin --profile X add dsh-jev-goal-judge` (published on npm as `dsh-jev-goal-judge@0.1.0`, CI green on GitHub Actions).
- **Numbers traceability**: the thresholds in the entry (0.75 / 0.6) are the shipped defaults in `src/config.ts`. The first live judgment against the real API is recorded in the README with full numbers: 828ms, 763 input tokens, $0.000032, routing **verify-complete** on a scenario whose ground truth was completion (achieved 0.83, evidence 0.90, progress 3.94/4, action confidence 0.97) — and that live run is also what caught and fixed a wire-format bug (`levels` → `criteria`) before it could reach users, shipped as v0.1.1.
- **AI disclosure**: this project was substantially written with an AI coding agent (DeepSeek Harness), and this submission was prepared with its assistance. The design decisions, verification, and publishing were directed and reviewed by the repository owner (kittimzhe).
- **Author batch**: single entry from this author, no sibling repositories.
