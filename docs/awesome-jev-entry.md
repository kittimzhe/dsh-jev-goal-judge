# awesome-jev submission draft

Status: **draft — do not submit until the GitHub repo exists and the README carries real shadow-mode numbers.**

Target list: [yibie/awesome-jev](https://github.com/yibie/awesome-jev) (upstream; local fork: kittimzhe/awesome-jev)
Target category: `categories/agent-decisions.md` — the decision step inside an agentic loop (goal-loop continuation is squarely this category; the driver's own continuation is the loop being gated).

## Entry line

```md
- [dsh-jev-goal-judge](https://github.com/kittimzhe/dsh-jev-goal-judge) `{agent: dsh}` - Coding agents: DeepSeek Harness plugin that judges every goal round at the turn-stopping seam with one Jev fan-out (achieved and evidence Nouls, a progress Score, a same-obstacle Noul, an action Choice) and steers a budgeted fixed-template verify-complete or report-blocked nudge back into the same turn so the goal-round driver never queues a round that would only re-confirm what the judge already saw; shadow mode by default, fail-open on every degrade, telemetry JSONL plus a /jev-goal-stats command, 53 offline tests.
```

## Inclusion-criteria self-check

| Rule | Evidence |
| --- | --- |
| Public and citable | GitHub repo (once created) + npm package |
| Uses Jev for a concrete decision task | goal-round progress judgment — one fan-out per round end |
| Names Jev / System One / typed-decision loop | README headline + question set + docs/DESIGN.md |
| One-sentence summary: scenario, method, value | the entry line above |
| Not a generic classifier with no Jev involvement | the whole actuator path routes on Jev probabilities |

## Submission flow (per the list's own tooling)

1. In the fork, append the entry to `categories/agent-decisions.md` under `## Entries`.
2. Run `python3 scripts/build-readme.py` to regenerate the aggregate README.
3. Commit, push, open a PR against upstream.
4. Mind CONTRIBUTING.md's AI-assisted-work and submission-rate rules — one entry, own repo, honest numbers only.

## Before submitting: fill in the receipts

- [ ] Real shadow-mode telemetry: judgments count, verdict distribution, p50/p95 latency, cost per round
- [ ] At least one real goal run where shadow would have steered (the money anecdote)
- [ ] CI badge green on the pushed repo
