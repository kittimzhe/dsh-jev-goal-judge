# Publish checklist

From local commit to listed project. Each step is independent of the next except where noted.

## 1. GitHub

- [ ] Create repo `kittimzhe/dsh-jev-goal-judge` (public, MIT, no auto-generated files)
- [ ] `git remote add origin git@github.com:kittimzhe/dsh-jev-goal-judge.git && git push -u origin main`
- [ ] CI (`.github/workflows/test.yml`) runs typecheck + 53 tests + build on the first push — confirm the badge goes green

## 2. npm

- [ ] `npm login` (the account that already publishes `dsh-session-recall`)
- [ ] `npm publish --access public` — package.json is already shaped for it (`publishConfig.access`, `files`, `dsh.bundle.patch`, peer deps externalized)
- [ ] Verify: `npm view dsh-jev-goal-judge version` and `dsh plugin --profile web add dsh-jev-goal-judge` in a scratch profile

## 3. Real-credential validation (needs the API key first)

- [ ] `node scripts/smoke.mjs` — one live judgment, verdict printed, exit 0
- [ ] Install into the daily profile in shadow mode; run one real goal
- [ ] `/jev-goal-stats` — capture the numbers for the README
- [ ] Optional: flip `mode: enforce` for one goal where shadow flagged verify-complete; record rounds saved

## 4. README receipts + awesome-jev

- [ ] Replace the `/jev-goal-stats` sample block in both READMEs with the real output
- [ ] Follow `docs/awesome-jev-entry.md` (fill its receipts section first, then PR to upstream)

## Ordering

The key unblocks 3; 3 feeds 4; 1 and 2 can go any time after the repo is created. If the key stays blocked, 1+2 can still ship — the plugin degrades cleanly with no key, and shadow-mode numbers can come from OpenRouter later by flipping `provider: openrouter`.
