# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-821 P0 实施中；真实数据不再阻塞开发】**
> Owner 裁决：质量评测只 mock 输入，输出必须走真实模型/真实生产链；mock-input 的
> real-output 评测可以关闭开发验收。真实 owner 数据仅用于决定是否扩大自动干预，
> 不再阻塞 P0/P1 代码实施。本轮实施全部 P0；P1 学科确定性 validator 只写计划。

## NOW

- **YUK-821：修复两个失败输出暴露的 claim/probe 错配（P0）**
  - `MindModelInductionTask` 只产 claim + 冻结 `DiagnosticSpec`，不再同时出题。
  - 自洽共识覆盖完整 DiagnosticSpec；claim 相似但 trigger/scope/wrong-answer
    signature 不同不算同票。
  - 新增独立 `ConjectureProbeAuthorTask` / `ConjectureProbeReviewTask`；通用结构门先查
    双题独立性和正确/目标错误答案差异，再由同模型第二次独立调用审查学科语义。
  - 第一次质量失败整包重生成；第二次质量失败 `abstain(no_discriminating_probe)`；
    provider/结构化输出故障保持 operational，不能凑成质量反对票。
  - nightly 与 agent director 共用质量门；proposal 保存 spec、双题 metadata、task run、
    failure code 和 audit；accept 缺 v3 包或发现持久化不一致时 409 fail closed。
  - 定向验证当前：unit 6 files / 212 passed；DB 4 files / 70 passed；typecheck、
    changed-file Biome、diff check 通过。完整 gate 不在本地跑，交给 GitHub CI Gate。
  - 20:47 用 mock 输入启动 canonical Opus real-output 复评；第一簇的 3 个独立
    induction call 均收到 429 weekly limit，按 operational stop condition 立即停止，
    没有把 fallback 或空输出记成质量结果。
- **YUK-814 闸门口径已按 owner 新决策修正**
  - 现有 harness 可继续用于真实 owner 观察数据，但它是扩大使用闸门，不是产品实施闸门。
  - synthetic/mock 仍不能冒充真实用户效果；但“mock 输入 + 真实模型输出”是合法的开发质量测试。

## NEXT

1. PR #1110 已创建；只监听 GitHub Actions 的 CI Gate，处理真实 review finding，
   不在本地重跑全 gate。
2. CI/评审通过后合并 P0；再用固定 mock evidence packets 跑 canonical Opus real-output
   质量评测。YUK-821 在 8 簇输出门通过前保持 In Progress，输出不合格就继续改模型合同，
   不伪造 pass。
3. 真实 owner shadow/blind/canary 留作扩大 auto-intervention 的发布证据，不阻塞后续功能实现。

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

## BLOCKED-ON

- **本次 P0 代码：无产品数据 blocker**；只剩 GitHub CI Gate 与 review。
- **canonical Opus 输出质量结论**：2026-07-29 20:47 实测被 429 weekly limit 阻断；
  配额故障只记 operational，不能用 Mimo fallback 的结果冒充 canonical pass。
- **auto-intervention 扩大使用**：仍需真实 owner/cohort shadow/blind/canary 证据；这是发布
  和扩量条件，不是继续实现功能的前置条件。
