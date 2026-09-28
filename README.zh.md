# dsh-jev-goal-judge

[![CI](https://github.com/kittimzhe/dsh-jev-goal-judge/actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-jev-goal-judge.svg)](https://www.npmjs.com/package/dsh-jev-goal-judge)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Jev](https://img.shields.io/badge/powered%20by-Jev%20%7C%20System%20One-ff6b35.svg)](https://typesafe.ai)

[English](README.md) | 中文

> **在 DeepSeek Harness 的 goal 轮次之间放一个 Jev 进度判断——每千轮约两美分。**
>
> dsh 的 goal-round driver 靠计数器续轮，而不是靠证据：`roundsStarted < maxGoalRounds` 是唯一的停止检查，工具策略还要求真实阻塞跨**三轮**持续才接受 `blocked`。本插件在每个轮次边界放一次有界的 [Jev](https://typesafe.ai) 类型化决策调用：当一轮的 turn 即将关闭时，judge 判断目标看起来已达成、有证据、还是卡在同一个障碍上——enforce 模式下会把一条固定模板的提示**注回同一个 turn**，让那些只会重复发现 judge 已知事实的轮次根本不会发生。

**一口气说完它做什么：** 在每个 goal 轮的 `agent/turn-stopping`，一次 Jev 扇出（`achieved`/`evidence` 两个 noul + `progress` 打分 + `sameObstacle` noul + `action` 选择，状态 ≤16k 字符，约 $0.00002）就关闭中的轮次对照目标做判断；高置信度的"已达成且有证据"判 steer 一句*"现在就去验证并标记 complete"*，高置信度的"又是同一个障碍"判 steer 一句*"要么报告 blocked 要么换打法"*——其余一切，包括所有错误、超时、冷却、低置信度，全部沉默，原生 driver 行为分毫不动。

## 为什么需要它

goal-round-driver 对自己的循环很诚实（`dsh-goal-round-driver` 源码）：

| 原生行为 | 代价 |
| --- | --- |
| `roundsStarted >= maxGoalRounds` 是**唯一**的停止检查 | 限额之内的每一轮都无条件执行 |
| 工具策略要求同一阻塞跨**三轮**持续才接受 `blocked` | 真实阻塞要额外烧两个完整 turn 来证明它无聊 |
| 没有任何东西检查已完成的工作是否满足目标 | 做完了却没调 `update_goal complete` 的 agent 白送一整轮去重新发现这件事 |

每浪费一轮就是一整个 agent turn 的 token。本插件把轮次之间的边界从计数器变成**有度量的决策**——与 `dsh-jev-interceptor` 在工具调用门控上做的事同构，落在 goal 循环上。

## 工作原理

```
session/event 流 ──► RoundObserver ──► 有界的每轮 digest
                                                │
agent/turn-stopping（串行）──────────────────►┤ goal active+armed？关闭中的 turn 是第 N≥1 轮？
                                                ▼
                                          一次 Jev 扇出
                                                │ 判定：on-track | verify-complete | report-blocked | uncertain
                                                ▼
                          shadow：只记 telemetry   enforce：+ agent.steer(<goal_judge> 提示)
                                                │
                                          /jev-goal-stats 读取 telemetry.jsonl
```

- **缝在哪里。** `agent/turn-stopping` 是官方文档定义的"反对关闭 turn"串行扩展点；它在 driver 于 idle 时排下一轮**之前**运行，零竞态。`steer()` 提交到 **next-step** 边界——driver 的竞争消息监听器只标记 `nextTurn` 插入，所以 judge 提示永远不会被误认成人类插话，永远不会暂停 goal。
- **judge 问什么。** 一次调用、五个固定问题。指令串是常量；转录文本只进 `state` 数据字段，工具输出改写不了问题本身。路由是确定性的：noul 阈值说了算，`action` 选择只打破平局——改阈值可以对着已记录的答案精确重放。
- **省在哪里。** 被 steer 的额外一步若以 `update_goal complete` 结束，driver 就根本不会排下一轮：**整轮省掉**。落地的 *"report blocked"* 提示把三轮阻塞证据变成一轮。

## 安全模型（真正该读的部分）

- **是 judge，不是守门员。** v1 从不改动 goal 状态——不 `block`、不 `pause`、不 `complete`、不 `disarm`。唯一的执行器是带固定模板建议的 `agent.steer()`。agent 和人始终是主权者，driver 自身的策略继续生效。
- **处处 fail-open。** 无密钥、冷却、超时、解析不符、置信度低于下限——全部退化为原生行为。本插件能缩短 goal；它不能延长、阻塞或放宽任何东西。
- **构造即有界。** assistant 尾部 ≤ 6000 字符、final message ≤ 2000、工具条目 ≤ 40、往轮 final ≤ 2 × 1500——远低于 Jev 的 32k state 预算。提供商侧：429/529/5xx 在剩余预算内重试一次，连续失败进冷却，并发有上限。
- **steer 预算。** 每个 goal 最多 2 次 `verify-complete`、1 次 `report-blocked` 提示：judge 说的话永远不会多于它省下的轮次。提示只以轮号参数化——任何模型或 Jev 生成的文本都不会被回显进 prompt。
- **先 shadow。** 默认模式把每个判定记入 telemetry（`<DSH_HOME>/dsh-jev-goal-judge/telemetry.jsonl`），零 steer。数字让你满意了再翻 `enforce`。

## 60 秒上手

```sh
dsh plugin --profile <name> add dsh-jev-goal-judge
```

```yaml
# 在你 profile 的 cordis.patch.yml 里（bundle 出厂即 shadow 模式）
- id: jev-goal-judge
  name: dsh-jev-goal-judge
  config:
    enabled: true
    mode: shadow            # 先观察：每个判定都落 telemetry
    provider: typesafe      # 或 'openrouter'（现在就能用，无候补名单）
    apiKeyEnv: TYPESAFE_API_KEY
```

正常使用 goal。shadow 模式下每个轮次边界都被判定并记录；`/jev-goal-stats` 汇总：

```
[goal-judge] judgments: 12  degraded: 1  steered: 0
  verdicts: on-track=9  verify-complete=2  report-blocked=1
  latency: p50 412ms  p95 890ms  max 1104ms
  input tokens: 7430  est. cost: $0.000312
```

满意 shadow 模式本会 steer 的内容？翻成 `mode: enforce`。

## 配置

一切都是配置字段——超时、冷却、并发、digest 上限、每个阈值、steer 预算（见 `src/config.ts` 的 `Config`）。值得注意的默认值：

- `mode: shadow`——你发话之前不 steer 任何东西。
- `minRoundsForBlocked: 2`——blocked 提示至少需要一轮前史可比较。
- `verifyCompleteMax: 2`、`reportBlockedMax: 1`——每 goal 的 steer 预算。
- 提供商端点：TypeSafe 直连（`api.typesafe.ai/v1/systemone`，模型 `jev-latest`）或 OpenRouter（`openrouter.ai/api/alpha/decisions`，模型 `~typesafe/jev-latest`）。密钥依次从 dsh 凭证缝（`~/.dsh/.credentials.yaml`）、启动环境、环境变量解析。

## 成本

Jev 1.13：每百万输入 token $0.042，输出免费。一次判定调用 500–2000 输入 token，每**轮**一次（不是每次工具调用）：**每轮约 $0.00002–0.00008**。一个 12 轮的 goal 全程判定成本不足千分之一美元。

## 本插件刻意不做的事

- 不直接改 `ctx.goals`——v1 只做建议式 steer，默认亦然。
- 不延长轮次、不做模型路由、不做压缩、不做跨 goal 记忆——一条缝，做透。
- steer 提示里没有自由生成的文本——固定模板，只有轮号。

## 开发

```sh
npm install --legacy-peer-deps
npm run typecheck            # src + tests 对着真实的 @deepseek-ai 类型
npm test                     # vitest，53 个用例，零网络
npm run bundle               # tsdown -> lib/
```

完整设计——缝位分析、问题集、路由表、安全模型——见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 许可

MIT
