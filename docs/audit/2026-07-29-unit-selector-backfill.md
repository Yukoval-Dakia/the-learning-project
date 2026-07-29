# YUK-820 affected-unit selector backfill

**日期**：2026-07-29  
**结论**：20/20 样本可计算 affected set，0 fallback、0 direct-test miss；切换 PR
required unit 为 affected，main push、global trigger 与 selector failure 继续 full。

## 方法

选择最近 20 个会被当前 lane planner 判为 `unit_selection=affected` 的已合并 PR。
每个样本使用 GitHub 保存的最终 PR head 与 `baseRefOid`：

1. 在 detached worktree checkout 最终 PR head；
2. 运行当前 selector：
   `vitest list --changed=<baseRefOid> --filesOnly --staticParse`；
3. 同一历史 checkout 列出当时的完整 unit test inventory；
4. 自动发现测试源码中直接使用 `node:fs` / `node:child_process` 的 source-scanning
   tests，并全部并入 affected set；
5. 检查直接改动且属于 unit partition 的 test 是否全部进入 affected set；
6. 核对该最终 PR head 的历史 required full gate 为 success。

这不是把当前 HEAD 对旧文件清单做静态猜测；selector 和完整 inventory 都在对应历史
PR head 上求值。20 个样本覆盖 server/API/job、UI、AI prompt/registry、跨进程状态、
测试-only 与多文件重构。

## 结果

- 20/20 selector `effective_mode=affected`
- 20/20 final PR full gate success
- 0 selector fallback / 0 selector error
- 20 个直接改动 unit test files，0 漏选
- 每个历史 checkout 自动保留 37–40 个 source-scanning unit tests
- 累计选择 1,120 / 9,639 test files（11.62%）
- 单 PR selection ratio：median 10.05%，min 8.20%，max 17.86%
- selector + full inventory / source-scan guard：median 3,972 ms，min 3,531 ms，
  max 10,224 ms

| PR | head | base | selected / full | ratio | direct unit tests | misses | selector ms |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| [#1081](https://github.com/Yukoval-Dakia/the-learning-project/pull/1081) | `16ef0c9d` | `c6ac037e` | 52 / 504 | 10.32% | 1 | 0 | 7,624 |
| [#1075](https://github.com/Yukoval-Dakia/the-learning-project/pull/1075) | `97176c13` | `8bc8e2ee` | 41 / 500 | 8.20% | 0 | 0 | 10,224 |
| [#1071](https://github.com/Yukoval-Dakia/the-learning-project/pull/1071) | `74ea0de3` | `6f7b1d40` | 42 / 500 | 8.40% | 0 | 0 | 9,424 |
| [#1070](https://github.com/Yukoval-Dakia/the-learning-project/pull/1070) | `c901c605` | `9aae957c` | 49 / 495 | 9.90% | 0 | 0 | 8,995 |
| [#1057](https://github.com/Yukoval-Dakia/the-learning-project/pull/1057) | `814e5262` | `f10cc6b6` | 52 / 492 | 10.57% | 0 | 0 | 4,223 |
| [#1056](https://github.com/Yukoval-Dakia/the-learning-project/pull/1056) | `7cdb5a60` | `f10cc6b6` | 49 / 492 | 9.96% | 0 | 0 | 4,354 |
| [#1052](https://github.com/Yukoval-Dakia/the-learning-project/pull/1052) | `ce2c7524` | `28e2812c` | 87 / 487 | 17.86% | 1 | 0 | 3,995 |
| [#1045](https://github.com/Yukoval-Dakia/the-learning-project/pull/1045) | `48d263e8` | `ce648b9a` | 49 / 483 | 10.14% | 0 | 0 | 3,903 |
| [#1037](https://github.com/Yukoval-Dakia/the-learning-project/pull/1037) | `0499f0b0` | `c06871c0` | 47 / 480 | 9.79% | 0 | 0 | 3,843 |
| [#1036](https://github.com/Yukoval-Dakia/the-learning-project/pull/1036) | `00768cd9` | `c06871c0` | 67 / 481 | 13.93% | 3 | 0 | 3,812 |
| [#1025](https://github.com/Yukoval-Dakia/the-learning-project/pull/1025) | `7adad3f0` | `4cb5b966` | 81 / 475 | 17.05% | 3 | 0 | 3,745 |
| [#1022](https://github.com/Yukoval-Dakia/the-learning-project/pull/1022) | `06716adc` | `91dd6490` | 43 / 475 | 9.05% | 0 | 0 | 3,669 |
| [#1021](https://github.com/Yukoval-Dakia/the-learning-project/pull/1021) | `dcef1e00` | `91dd6490` | 39 / 475 | 8.21% | 1 | 0 | 3,637 |
| [#1020](https://github.com/Yukoval-Dakia/the-learning-project/pull/1020) | `92d75682` | `91dd6490` | 77 / 475 | 16.21% | 1 | 0 | 3,948 |
| [#1011](https://github.com/Yukoval-Dakia/the-learning-project/pull/1011) | `be93f9a0` | `5b26698d` | 45 / 471 | 9.55% | 2 | 0 | 3,999 |
| [#1010](https://github.com/Yukoval-Dakia/the-learning-project/pull/1010) | `4dbfd812` | `5b26698d` | 81 / 471 | 17.20% | 2 | 0 | 3,805 |
| [#1008](https://github.com/Yukoval-Dakia/the-learning-project/pull/1008) | `21d57577` | `5b26698d` | 80 / 471 | 16.99% | 2 | 0 | 3,531 |
| [#1007](https://github.com/Yukoval-Dakia/the-learning-project/pull/1007) | `06a0c036` | `5b26698d` | 48 / 471 | 10.19% | 1 | 0 | 3,722 |
| [#1002](https://github.com/Yukoval-Dakia/the-learning-project/pull/1002) | `2516ab1f` | `0a469897` | 46 / 471 | 9.77% | 2 | 0 | 4,464 |
| [#1000](https://github.com/Yukoval-Dakia/the-learning-project/pull/1000) | `6276fa48` | `61a996cd` | 45 / 470 | 9.57% | 1 | 0 | 4,814 |

另保留 [#1059](https://github.com/Yukoval-Dakia/the-learning-project/pull/1059)
作为 fail-closed 负控：Vitest import graph 返回空 affected set，当前 selector 明确输出
`vitest-affected-empty` 并执行 full unit，而不是只靠 sentinel 制造一个看似非空的选择集。

## 真实失败 head 回放（补充）

随后不再只看最终 green head，而是从失败 CI Gate 的 annotations 反查真实失败测试，
在对应失败 head 与 merge-base 上重放 selector。结果：**21/21 失败 run 被捕获**，
覆盖 **18 个 PR**；20 次进入 affected，1 次因 import graph 为空 fail-closed 到 full。

| failed run | PR | 失败 unit 文件 | mode | selected / full | 捕获 |
| --- | ---: | --- | --- | ---: | --- |
| [30198413876](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30198413876) | #1080 | `src/capabilities/shell/ui/TeachingBrief.interaction.unit.test.tsx` | `affected` | 247 / 503 | yes |
| [30112370038](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30112370038) | #1063 | `src/server/ai/retry-optin.test.ts` | `affected` | 91 / 493 | yes |
| [30084945249](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30084945249) | #1051 | `src/server/ai/runner-fn.unit.test.ts` | `affected` | 202 / 491 | yes |
| [30073732421](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30073732421) | #1044 | `src/server/event-subscriptions/dispatch-mount.unit.test.ts` | `affected` | 157 / 485 | yes |
| [30010374097](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30010374097) | #1040 | `src/server/export/constants.test.ts` | `affected` | 162 / 482 | yes |
| [29837688009](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29837688009) | #1018 | `src/capabilities/notes/jobs/hub-sync-wake.unit.test.ts` | `affected` | 475 / 475 | yes |
| [29743148302](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29743148302) | #1007 | `src/capabilities/notes/server/note-refine-triggers.unit.test.ts` | `affected` | 48 / 471 | yes |
| [29692705393](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29692705393) | #948 | `src/capabilities/shell/ui/InboxPage.progressive.unit.test.tsx` | `affected` | 67 / 449 | yes |
| [29692553743](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29692553743) | #939 | `scripts/audit-draft-status.test.ts` | `affected` | 161 / 450 | yes |
| [29691113368](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29691113368) | #943 | `tests/integration/audit-docs-invariant.test.ts` | `affected` | 168 / 450 | yes |
| [29689572402](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29689572402) | #939 | `scripts/audit-draft-status.test.ts` | `affected` | 161 / 449 | yes |
| [29685670055](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29685670055) | #938 | `scripts/audit-draft-status.test.ts` | `affected` | 46 / 446 | yes |
| [29682019270](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29682019270) | #929 | `src/server/ai/runner.seam.test.ts` | `affected` | 74 / 438 | yes |
| [29680191467](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29680191467) | #919 | `src/core/schema/schema.test.ts` | `affected` | 126 / 430 | yes |
| [29679581087](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29679581087) | #919 | `src/core/schema/schema.test.ts` | `affected` | 126 / 430 | yes |
| [29678354960](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29678354960) | #919 | `src/core/schema/schema.test.ts` | `affected` | 123 / 423 | yes |
| [29577461338](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29577461338) | #836 | `tests/core/today/proposal-kpi.test.ts` | `affected` | 51 / 390 | yes |
| [29130862350](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/29130862350) | #764 | `src/capabilities/observability/api/admin-subjects.unit.test.ts` | `affected` | 30 / 338 | yes |
| [28848162764](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/28848162764) | #730 | `src/capabilities/composition.unit.test.ts` | `affected` | 71 / 323 | yes |
| [28743916796](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/28743916796) | #708 | `tests/integration/audit-docs-invariant.test.ts` | `full` | 0 / 306 | yes |
| [28436896575](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/28436896575) | #686 | `tests/integration/step9-invariant-audit.test.ts` | `affected` | 90 / 295 | yes |

最初按文件名初筛时出现 3 个“unit miss”，但历史 `vitest.unit.config.ts` inventory 证明它们
均不属于 unit partition，而是 plain-name DB tests：

- run [30059492833](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30059492833) / PR #1041: `src/server/boss/handlers/quiz_gen.test.ts`
- run [30058806384](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30058806384) / PR #1046: `src/server/boss/handlers/quiz_gen.test.ts`
- run [30038936493](https://github.com/Yukoval-Dakia/the-learning-project/actions/runs/30038936493) / PR #1044: `src/server/ai/tools/proposal-tools.test.ts`

因此它们是 annotation 分类假阳性，不是 unit selector 漏选；也正是 DB selector 要覆盖的失败样本。

## 证据边界与切换护栏

前 20 个最终 PR head 样本仍只证明真实 diff 可稳定求值、直接改动 test 不漏、selected set
远小于 full；不能把它们冒充故障注入。补充的 21 个真实失败 run 才证明：在 annotations
记录的实际 unit failure 上，selector 20 次直接选中、1 次 fail-closed full，漏选为 0。
Comparator 的 missed-failure / fallback 行为另由 `scripts/ci/unit-shadow.test.ts` 的负控固定。

基于 owner 允许历史 backfill 代替等待 20 个未来 PR，切换仍保留：

- unknown/global/base/diff error → full；
- selector 缺失、无效、fallback 或空 affected set → full；
- main push → full canary；
- direct test edits 对明确 convention 分流；plain-name allowlist 归属不明时保守同时跑
  unit + DB，避免任一 partition 排除后漏测；
- 自动发现的 source-scanning invariant tests 永远并入 affected set；
- Vitest 原始 affected graph 为空时，即使存在 source-scanning tests 也回退 full；
- 两次 selector inventory 各有 120 秒上限；required unit process 有 15 分钟上限；
- required affected run 的退出码仍由 aggregate gate 强制为 success。
