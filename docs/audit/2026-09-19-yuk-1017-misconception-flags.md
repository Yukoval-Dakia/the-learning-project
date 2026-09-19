# YUK-1017 — misconception 三 flag 启用裁决（454-C）

> 2026-09-19 · owner 指令「1017启用」= 显式 owner GO 意向；本文件按
> `docs/audit/2026-07-31-yuk-741-recurrence-batch.md` §4 的五行 go/no-go 门槛逐行收新证据后裁决。

## 裁决总表

| Flag | 机制 | 裁决 | 依据 |
| --- | --- | --- | --- |
| `MISCONCEPTION_PROMOTE_ENABLED` | env（`misconception-promote.ts`；live reader `conjecture-accept.ts` accept 路径） | **GO → 本 PR 翻开**（`docker-compose.mac.yml` app+worker `"true"`） | owner 拍板即可开；accept 仍 owner 手动门槛，`!isEdit && recurrence_count >= K_PROMOTE(=2)` 才 mint，同 tx 原子（rate event + probe serve 一起回滚）。回滚=删行+recreate，与既有两 flag 同约定。 |
| `MISCONCEPTION_HARD_CONFIRM_ENABLED` | env（同文件 kill switch） | **维持 OFF，不注入** | ADR-0050 §(b2)：Judge 无诚实 `target_error_match` fact，且 soft→hard 必须 owner 当刻新确认——nightly caller 恒 `ownerFreshlyConfirmed=false`，结构性不可执行 protected mutation。无动作仅确认。 |
| `MISCONCEPTION_RECURRENCE_ENABLED` | 编译期 const（`selection-constants.ts:92`） | **NO-GO，保持 `false`** | 五行门槛新证据见下——3、4 行证据基底在 production 不存在；第 2 行最紧代理口径 borderline。 |

## Recurrence 五行门槛 · 新证据（2026-09-19）

| Gate | 门槛 | 新证据 | Verdict |
| --- | --- | --- | --- |
| 1 Batch correctness | exact-head CI 绿 + 等价/稀疏/高基数/预算测试 | YUK-741 合入后历次 exact-head CI Gate 全绿（含 2026-09-19 `4a40e14c3` run `35421321142`）；`candidate-signals.db.test.ts` 钉住 frozen-reference 等价、空/稀疏/200 高基数、provenance-overlap、查询预算 | **GO** |
| 2 Prod-like latency | ≥30 warm runs @200 候选：查询数=1；batch p95 < serial p50；whole-request p95 回退 ≤10% | 本机 Testcontainers/pg16、200 KC/200 题/200 active mistake、32 warm runs ×3 轮：serial p50≈883–946ms；batch p50≈4.2–5.5ms、p95≈7.4–13.0ms、查询数恒=1；`collectCandidateSignals` 200 题候选 OFF/ON 配对采样 p50 边际 +3.4ms（~5%），但 **p95 回退三次两超 10% 线**（121.6 vs 94.8×1.1；124.0 vs 106.2×1.1；一轮过线 123.5≤125.6）。该代理是「最紧」口径（~65ms 纯信号基线，真实请求基线更大同额成本占比更小），严格读仍判 borderline | **borderline（2/4 子项稳过，p95 回归未稳）** |
| 3 Judge health | contrastive headline + 全部喂题路由 `status='ok'`；bit agreement ≥80%；近期 runs 零错误 | **production 基底不存在**：`experimental:judge_calibration_sample` / `run_summary` 事件 **0 条**（job 无可采样对象）；判分历史仅 9 条 judge event | **NO-GO** |
| 4 Cause-label calibration | owner-blind 审 ≥20 条近期 active mistake、全科目、grounded ≥80%、红线=0 | **production 基底不存在**：全库 1 条 attempt、9 条 judge（4 correct/3 incorrect/2 partial）——active mistake ≤5，远低于 ≥20 样本要求 | **NO-GO** |
| 5 Owner GO + rollback | owner 显式 GO + 独立 flag-only PR + 红线即回滚 | owner 已授 GO 意向（「1017启用」），但门槛文档要求**全部行**有新鲜证据；3、4 行无基底可证 | blocked by 3/4 |

**结论**：recurrence 不翻。阻塞不在代码——在数据基底：系统内可校准的 failure 量不足以支撑 judge-health 与 cause-label 两行证据。等真实 mistake 量积累到 ≥20 条/科目 + 校准 job 有样本后重估本表（届时第 2 行建议用真实请求面而非裸 `collectCandidateSignals` 代理复测）。

## 启用后观察面（promote）

- `conjecture-accept` 同 tx 落：rate event → misconception 行（`misc_<hex>` deterministic id）+ `caused_by` edge → probe serve。
- 观察点：inbox accept 一条 `conjecture`（recurrence_count ≥ 2）→ `misconception` 表新增 soft 行 + `misconception_edge`；454-A 后该节点随即进 attribution retrieve 候选。
- 回滚：`docker-compose.mac.yml` 删两行 + `docker compose up -d --force-recreate app worker`——已 mint 的 soft 行保留（edit-accept 的 `archiveSoftMisconceptionForConjecture` 清理刻意独立于 flag，OFF 回滚后仍能归档）。
