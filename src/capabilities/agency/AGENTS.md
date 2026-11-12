# src/capabilities/agency — 能动编排

> 夜间链路（dreaming / maintenance / research meeting）+ 学习者回访时按需唤醒的 coach + goal scope 提议 + agent-notes。agent-notes 是 AI 内部协调信道（hints not facts），用户侧只读观察窗。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | API、job/cron、proposal kinds、copilot tools、event subscriptions/actions 与 todayBlock 的权威注册面（清单以 `manifest.ts` 为准） |
| `api/*.ts` | agent-notes、goal-create、probe-answer（conjecture 判别探针作答，#13 通电——与 attempt/FSRS 写面隔离，只写 1 个 `experimental:probe_result` 事件） |
| `server/` | dreaming nightly、coach daily、goal scope propose、conjecture、agent-notes、proposal-appliers |
| `server/learning-intent-request.ts` | 学习意图创建的一次付费请求：在途只派一次；领域结果已知收成终态；当前发送未知时不重派，也不沿用上一意图；本次发送落的 pending 提案收成回执；无终态的流保持未决；提案决定只补本次回执 |
| `server/conjecture/reconcile.ts` | 有效 probe 结果记账与纠错回放；先写 typed ledger，最后写确定性 anchor；execution checkpoint 归相邻 `reconciliation-execution.ts` |
| `server/conjecture/learner-evidence.ts` | 把干预 `evidence_refs` 解析成有上限的错答块（原答、判定、错因），经 kernel `learner-evidence` 端口给补救材料作者 |
| `server/conjecture/accountability.ts` / `hard-confirm.ts` | 共享预测问责排序与纠错有效事实读取；nightly 与 grounding candidate collector 消费同一 reader/ranker |
| `jobs/` | `dreaming_nightly`、`coach_daily`、`goal_scope_propose_nightly`、`research_meeting_nightly`，以及 `prepare_intervention` / `intervention_prepare_recovery` |
| `ui/AgentNotesPage.tsx` | `/agent-notes` 观察窗 |

## CONVENTIONS
- 夜链 cron 全部 `Asia/Shanghai`；pg-boss cron 自带 singleton 语义。
- queue 档：`agent` 给多 tool-call LLM job（dreaming、research meeting）；`llm` 给单次/轻量 LLM job（coach）。
- proposal kind 归属与 applier 存在性解耦：有 producer 无 accept applier 的 kind（如 `defer`）在 dispatch 壳 default throw。
- 夜间整理（curator）不写笔记刷新事件，也不再为 note_update 入队 refine。

## ANTI-PATTERNS
- 学习事实变更仍经 propose event + 用户 accept；Curator 可直接写可逆记忆版本，不改判分、掌握度或排程。
- 改 cron 时刻前先看链上 offset 注释，避免锁竞争/读不到同夜 proposal。
