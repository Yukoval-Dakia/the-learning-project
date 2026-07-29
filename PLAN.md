# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-821 P0 实施中；真实数据不再阻塞开发】**
> Owner 裁决：质量评测只 mock 输入，输出必须走真实模型/真实生产链；mock-input 的
> real-output 评测可以关闭开发验收。真实 owner 数据仅用于决定是否扩大自动干预，
> 不再阻塞 P0/P1 代码实施。本轮实施全部 P0；P1 学科确定性 validator 只写计划。

## NOW

- **YUK-821：P0 严格收口，不再把“主链已合并”误报成“全部完成”**
  - PR #1110 已把 claim + DiagnosticSpec 共识、独立 Author/Reviewer、整包重生成、
    nightly/director 共用质量门及 fail-closed accept 合入 main。
  - 复审发现两个真实缺口：旧 `passed=true` audit 未绑定 reviewer 实际看过的题包；
    成功 audit 仍允许 author/reviewer task-run id 为空。因此 P0 在本轮开始时并未全收。
  - 当前补 `probe_quality` v2：保存独立 `reviewed_package` 快照；成功尝试强制完整
    author/reviewer lineage；proposal schema 与 accept 同时校验 audit 和最终落库题包一致。
  - 新迁移 0083 用 agent-authored correction 退出 pending 的 v1、缺 lineage 或题包错配
    记录；不伪造 owner dismiss、不写 memory outbox、不留下永久 409 卡片。
  - P1 学科确定性 validator 仍只保留详细计划，未写代码。
- **开发/发布闸门**
  - 只 mock 输入，输出必须走真实模型与生产任务链；真实 owner 数据不阻塞开发，
    只决定是否扩大 auto-intervention。
  - 本地只跑变更相关 unit/DB/migration/typecheck/Biome；完整 gate 只监听 GitHub CI Gate。

## NEXT

1. 完成 audit v2、0083 迁移、生成 API contract 与定向验证；批量一次提交/PR。
2. 只监听 exact-head GitHub CI Gate，清零 review threads 后合并。
3. 在合并 main 上重跑固定 8-case mock-input/真实-output；相对旧基线有改善即通过开发 gate。
4. 通过后对齐 YUK-821，并按 mesh 依赖选择下一条 ready phase issue 开发。

## PARKED

- **YUK-822：P1 学科确定性验证器（本次不写代码）**
  - 详细通俗计划：`docs/planning/2026-07-29-yuk-821-conjecture-probe-quality.md`。
  - 第一批仅做数学的复合单位分母变换与异分母分数相加；subject-owned registry，
    不在 Agency 写中央学科 switch；parser 不可判定时 fail closed。
  - P1 需要版本化 validator provenance、mutation tests、shadow→blocking 切换与 kill switch。
- **干预准备/结算/协作档案**：YUK-791/796、YUK-792、YUK-815、YUK-816；不再被
  “必须先有真实 owner 数据”整体阻塞，但仍须按 mesh 依赖顺序推进。
- **CI selector drift**：main full canary 或 direct-test guard 发现漏选即回退 full required；
  以 GitHub timing/coverage 为证据，不在本机猜测。
- **YUK-820 live timing**：DB affected selector 已随 main 合并并完成 20/20 failed-head
  回放；仍等待下一条不触及 schema/migration/CI 自身的普通 server/API PR 验收 wall-clock。
- **YUK-823 已 Done**：PR #1112 / `c4c26c76` 已把 TS7 native compiler、TS6 fallback、
  native watch 与跨 CI run buildinfo 合入 main；PR #1113 / `766351a5` 完成看板收口。
- **YUK-824 本地 lint 假红**：只处理 sanctioned `.ykv/**` code-index cache 的精确忽略，
  不扩大 Biome `files.maxSize`，不混入 YUK-821。

## BLOCKED-ON

- **本次 P0 代码：无产品数据 blocker**；只剩最终批次 exact-head GitHub CI Gate 与合并。
- **canonical Opus 输出质量结论**：2026-07-29 20:47 实测被 429 weekly limit 阻断；
  配额故障只记 operational，不能用 Mimo fallback 的结果冒充 canonical pass。
- **auto-intervention 扩大使用**：仍需真实 owner/cohort shadow/blind/canary 证据；这是发布
  和扩量条件，不是继续实现功能的前置条件。
