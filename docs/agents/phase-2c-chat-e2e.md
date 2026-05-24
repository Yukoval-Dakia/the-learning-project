# Phase 2C Chat Deploy + Browser E2E Verification (YUK-47)

**Date**: 2026-05-24
**Verified against**: main `a8fab4a` (含 YUK-13 design doc + YUK-64 hotfix)
**Environment**: 本地 OrbStack docker-compose（替代 NAS production verification per user authorization; `docker-compose.yml` + `docker-compose.local.yml` overlay）
**Verifier**: Claude orchestrator + Playwright MCP browser automation

## Acceptance check

| 项 | Status | 证据 |
|---|---|---|
| NAS 容器 rebuild 成功（最新 main） | ✅ | `docker compose build app` exit 0 after [YUK-64](https://linear.app/yukoval-studios/issue/YUK-64) hotfix landed; container `the-learning-project-app-1` recreated from new image, app `Ready in 326ms`, HTTP 200 on `/api/health` |
| 浏览器开 `/learn/[id]/chat` 完成 3-turn 真聊 | ✅ | Learning item `wbsqaz0bn1zf8kaew0x76y4c` ("smoke test item" · 文言文 · seed:wenyan:duanju)，"→ 对话教学" drawer，session `wztwvv2q…`，3-turn 全部 round-trip 返回 mimo `TeachingTurnTask` response（讲解 → 讲解 → 追问） |
| 无 console error / 无 hydration mismatch | ✅ | Chat session 期间 console **0 errors / 0 warnings** during all 3 turns. /today 初次加载只有 favicon.ico 404 + DOM password field 非 form verbose（cosmetic, not real errors） |
| `ai_task_runs` / `cost_ledger` 看到 mimo call | 🟡 | **Blocked by [YUK-65](https://linear.app/yukoval-studios/issue/YUK-65)** —— postgres 容器缺 YUK-41 migration（容器 up 7 day，YUK-41 在那之后才 ship）。`/admin/runs` 返 500 "Failed query ... from ai_task_runs"。Chat 本身 streaming 正常 —— DB 写入 path 待 YUK-65 fix 后 retest |
| 发现的 bug 录入新 issue | ✅ | 本次 E2E 发现 2 个 incidental issue：[YUK-64](https://linear.app/yukoval-studios/issue/YUK-64) (P0 docker build break, ✅ shipped a8fab4a) + [YUK-65](https://linear.app/yukoval-studios/issue/YUK-65) (Medium compose-no-migrate) |

## 3-turn chat transcript

**Context**: 学习项 "smoke test item"，知识点 `seed:wenyan:duanju` (断句)，模型 mimo via `TeachingTurnTask`，session `wztwvv2q…`

| Turn | User | Agent (kind) |
|---|---|---|
| (init) | — | `讲解`：文言文断句概念 + 核心依据（语义 + 句式标志） |
| 1 | 什么是断句？给我一个简短的例子 | `讲解`：「学而不思则罔思而不学则殆」→ 断后是「学而不思则罔，思而不学则殆。」+ 解释判断过程 |
| 2 | 如果碰到没有「者...也」这种明显标志的句子，怎么判断断在哪？ | `讲解`：「秦王坐章台见相如相如奉璧奏秦王」例子，主语转换 + 句法结构作 fallback |
| 3 | 明白了。出一道断句题考我吧 | `追问`：试断「晏子至楚王赐晏子酒酒酣吏二缚一人诣王」 |

3 轮 mimo round-trip 全部成功，agent 内部 turn type 从 "讲解" 自动切到 "追问"（出题模式）。Session 状态 `active`，没出现 spinner / hang。

## Screenshot

[Full page screenshot](phase-2c-chat-e2e.png) — `/learning-items/wbsqaz0bn1zf8kaew0x76y4c` with chat drawer open showing all 3 turns + agent question card。

## Verified infrastructure

- ✅ Next.js 15.5.18 standalone build serving from container
- ✅ INTERNAL_TOKEN gate via `/today` first-time setup + localStorage
- ✅ Learning-item detail page rendering note artifact (verification status: 已验证)
- ✅ Conversation drawer pattern (right complementary panel)
- ✅ Session lifecycle: `learning_session(type='conversation', status='active')`
- ✅ TeachingTurnTask streaming via xiaomi/mimo Anthropic-compat endpoint
- ✅ Quick-action buttons present (`再讲一遍 / 出题考我 / 我懂了`)

## Known gaps (filed)

1. **[YUK-65](https://linear.app/yukoval-studios/issue/YUK-65)** — `docker compose up` 不 auto-migrate postgres，导致 `/admin/runs` (YUK-41) 500。本次 chat 仍能跑（TeachingTurnTask 不直接需要 ai_task_runs 写入），但 obs surface 全炸。Medium priority。
2. **[YUK-64](https://linear.app/yukoval-studios/issue/YUK-64)** — main 上 docker build break (YUK-36 layering violation)，本次 E2E 前 hotfix 已 ship 在 main commit `a8fab4a`。

## Not in scope

- ❌ NAS production deploy (per Linear issue 描述：local OrbStack 等同 acceptable verification, NAS push 待 user 手动)
- ❌ idle state machine verification (YUK-14 实现没 ship — design doc YUK-13 just landed)
- ❌ Full DB-level verification of ai_task_runs / cost_ledger / tool_call_log 写入 (blocked YUK-65)

## Conclusion

Phase 2C teaching chat **functionally verified** end-to-end in fresh build of main `a8fab4a`. 3 真聊 turns 均成功 round-trip 返回有意义的内容，session 状态正确流转，零 console error。剩余 DB-level evidence 验证被 [YUK-65](https://linear.app/yukoval-studios/issue/YUK-65) 阻塞，不影响 chat 本身可用性。

YUK-47 acceptance：4/5 直接 verified + 1 blocked-by-downstream-issue 已 filed。
