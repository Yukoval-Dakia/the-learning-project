# YUK-820 DB affected selector：失败 head backfill 与关键路径复盘

**日期**：2026-07-29
**结论**：此前 affected unit 已显著减少 unit 工作量，但 CI wall-clock 由全量 DB shards 决定；本轮把 DB required gate 也切到 fail-closed affected selection。20 个真实失败 head 全部捕获。

## 为什么用户看到的总耗时几乎没变

用 PR #1108 与其合并后的 main push 做同代码对照：

| 指标 | PR affected run [30447000426](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30447000426) | main full run [30447542212](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30447542212) |
| --- | ---: | ---: |
| wall-clock | 404 s | 394 s |
| unit step | 41 s | 132 s |
| unit job | 76 s | 159 s |
| DB shard 1 step/job | 303 / 336 s | 316 / 341 s |
| DB shard 2 step/job | 328 / 354 s | 326 / 355 s |
| runner time sum | 905 s | 1,070 s |

因此 unit step 确实减少 **91 s（69%）**，unit job 减少 **83 s（52%）**，runner time 减少 **165 s（15.4%）**；但 DB critical path 仍约 354–355 s，所以总 wall-clock 没缩短，甚至在 runner 噪声下多 10 s。这个观察成立，不是 selector “看起来生效”就算验收。

## 本轮实现

- gate planner 新增 `db_selection=skip|affected|full`；普通 server/API/job/subject 与 DB-test diff 使用 affected，main push、schema/migration/config/workflow/kernel/core/unknown 继续 full。
- `scripts/ci/db-affected.mjs` 用历史 merge-base 执行 `vitest list --config vitest.db.config.ts --changed=<base> --filesOnly --staticParse`，再与当时完整 DB inventory 交叉验证。
- 直接改动但未被 import graph 选中的 DB test 会立即回退 full。
- 自动并入 source-scanning 与 dynamic-import DB tests；真实失败回放暴露的 out-of-graph failures 固化为显式 failure sentinels。
- selector 缺失、坏 JSON、unsafe base、diff/list 失败、空 affected set 均由 required runner 回退 full。
- affected 文件仍在两个 DB jobs 中分 shard；文件少于 shard 数时只跳真正为空的 shard；每个 shard 上传 selection/execution artifact。

## 真实 DB 失败 head 回放

- 20 个失败 run，覆盖 15 个 PR；与 unit 失败样本合并后覆盖 30 个不同 PR。
- 最终：**20/20 捕获，0 miss**；19 affected，1 fail-closed full。
- 纯 import graph 初版只捕获 18/20；两个真实 out-of-graph failures 分别是 `quiz_gen.test.ts` 与 `propose_edge.db.test.ts`，已成为 required failure sentinels，而不是从报告里删掉。
- 19 个 affected 样本累计选择 4,677 / 7,051 files；ratio median 79.9%，min 12.4%，max 100.0%。这说明窄 PR 可大幅缩小 DB 集合，但大范围 server 重构仍会接近 full。
- selector median 5,835 ms。

| failed run | PR | failing DB files | mode | selected / full | caught |
| --- | ---: | --- | --- | ---: | --- |
| [30402545039](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30402545039) | #1101 | `src/server/conjectures/hard-confirm.db.test.ts` | `affected` | 228 / 389 | yes |
| [30367501416](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30367501416) | #1098 | `src/capabilities/agency/api/probe-answer.db.test.ts`<br>`src/capabilities/agency/server/conjecture/probe-lifecycle.db.test.ts`<br>`src/capabilities/shell/server/prep-desk-probes.db.test.ts` | `affected` | 334 / 388 | yes |
| [30357417316](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30357417316) | #1098 | `src/capabilities/agency/server/conjecture-accept.db.test.ts`<br>`src/capabilities/shell/server/prep-desk-probes.db.test.ts`<br>`src/capabilities/shell/server/teaching-brief.db.test.ts` | `affected` | 334 / 388 | yes |
| [30355997941](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30355997941) | #1098 | `src/capabilities/agency/server/conjecture-accept.db.test.ts`<br>`src/capabilities/shell/server/prep-desk-probes.db.test.ts` | `affected` | 334 / 388 | yes |
| [30354068667](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30354068667) | #1098 | `src/capabilities/agency/api/probe-answer.db.test.ts`<br>`src/capabilities/agency/server/conjecture-accept.db.test.ts`<br>`src/capabilities/shell/server/teaching-brief-edited-claim.db.test.ts`<br>`src/server/conjectures/reconcile.db.test.ts` | `affected` | 334 / 388 | yes |
| [30330827827](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30330827827) | #1098 | `src/capabilities/agency/server/conjecture-accept.db.test.ts`<br>`src/capabilities/shell/server/teaching-brief-edited-claim.db.test.ts`<br>`src/server/conjectures/reconcile.db.test.ts` | `affected` | 334 / 388 | yes |
| [30244517044](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30244517044) | #1085 | `src/capabilities/practice/jobs/judge_pending_reconcile.db.test.ts` | `affected` | 306 / 383 | yes |
| [30241642447](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30241642447) | #1084 | `src/capabilities/agency/server/conjecture/evidence-enrichment.db.test.ts` | `affected` | 169 / 380 | yes |
| [30202522828](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30202522828) | #1085 | `src/capabilities/practice/api/judge-run-status-route.db.test.ts` | `affected` | 306 / 383 | yes |
| [30156592520](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30156592520) | #1076 | `src/server/orchestration/orchestrator.db.test.ts` | `affected` | 148 / 379 | yes |
| [30059492833](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30059492833) | #1041 | `src/server/boss/handlers/quiz_gen.test.ts` | `affected` | 192 / 365 | yes |
| [30058806384](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30058806384) | #1046 | `src/server/boss/handlers/quiz_gen.test.ts` | `affected` | 45 / 362 | yes |
| [30038936493](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30038936493) | #1044 | `src/server/ai/tools/proposal-tools.test.ts` | `affected` | 361 / 364 | yes |
| [30003122204](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30003122204) | #1040 | `src/capabilities/observability/api/_round_trip.db.test.ts`<br>`src/capabilities/observability/api/backup-export.db.test.ts`<br>`src/capabilities/observability/api/backup-import.db.test.ts`<br>`src/capabilities/observability/api/restore_column_allowlist.db.test.ts`<br>`src/server/export/mem0-collection-backup.db.test.ts`<br>`src/server/export/reverse_lockstep.db.test.ts` | `affected` | 358 / 361 | yes |
| [29954060736](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29954060736) | #1033 | `src/capabilities/copilot/server/copilot-tools.db.test.ts` | `affected` | 138 / 359 | yes |
| [29820714015](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29820714015) | #1018 | `src/capabilities/observability/api/_round_trip.db.test.ts`<br>`src/capabilities/observability/api/backup-export.db.test.ts`<br>`src/capabilities/observability/api/backup-import.db.test.ts`<br>`src/capabilities/observability/api/restore_column_allowlist.db.test.ts`<br>`src/server/export/mem0-collection-backup.db.test.ts`<br>`src/server/export/reverse_lockstep.db.test.ts` | `affected` | 358 / 358 | yes |
| [29691714801](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29691714801) | #945 | `src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts` | `affected` | 134 / 346 | yes |
| [29679732974](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29679732974) | #918 | `src/capabilities/knowledge/server/propose_edge.db.test.ts` | `full` | full fallback | yes |
| [29678944454](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29678944454) | #917 | `src/capabilities/knowledge/server/propose_edge.db.test.ts` | `affected` | 94 / 342 | yes |
| [29676672284](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29676672284) | #913 | `src/capabilities/knowledge/server/propose_edge.db.test.ts` | `affected` | 170 / 340 | yes |

## 同代码 replay 验证边界

在 #1108 的 exact merged tree（base `a9df19cf` → head `07c6516e`）上，最终 DB selector 选出 195 / 390 files（含 9 个 source-scanning、38 个 dynamic-import、2 个 failure sentinels，集合有重叠）。其 181-file 前序集合已由两个 affected shards 实际执行：91 + 90 files，1,219 + 1,130 tests 全绿（另有 3 + 6 skipped）；新增 dynamic-import sentinels 由随后完整 390-file pre-PR suite 覆盖。

该本机 replay 在同一台机器并发启动两个 Testcontainers，wall-clock 受本机资源争用影响，不能冒充 GitHub runner 的节省值。能确认的是选择集可执行且测试全绿；真实 GitHub wall-clock 改善要由下一条普通 server/API PR 的 artifacts 与 job timing 验收。当前修改本身触及 `scripts/ci/**` 和 workflow，按 fail-closed 规则其 PR 必须跑 full；合并后的 main push 也必须 full。
