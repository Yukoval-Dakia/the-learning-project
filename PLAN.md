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
  - 升级迁移用 agent-authored `correct(retract)` 收口旧 v1/v2 pending 猜想，不伪造
    owner dismiss，不再让旧 Teaching Brief 卡在“永远 409 但仍 pending”。
  - Director 只接受本次会议快照中可完整物化的文本 failure attempt/review；缺题目快照、
    图片/图形、probe_result/prediction_score 一律失败关闭，不再让 author/reviewer
    在证据被静默丢弃后签发 pass。
  - 定向验证当前：unit 6 files / 212 passed；DB 4 files / 70 passed；typecheck、
    changed-file Biome、diff check 通过；审查修复增量 unit 2 files / 61 passed、DB 2 files /
    29 passed；远端 DB lane 暴露旧 Director fixtures 缺快照后，定向 DB 1 file /
    18 passed；migration 定向 1 passed / 26 skipped。完整 gate 不在本地跑，交给
    GitHub CI Gate。
  - merge-head 审查新增问题已收口：Director 证据先截断并标为不可信文本；运行 charter
    只允许可物化的 attempt/review；probe author/reviewer operational failure 重新抛给
    pg-boss；proposal 规范化、accept 失败码、blind artifact 与 structured-output
    守卫补齐。增量 unit 5 files / 171 passed、DB 1 file / 23 passed、typecheck 通过。
  - exact-head `2d754dc5` 的远端 CI Gate `30460326628` 全绿。随后两条新 review 已修：
    Director 按 KC 从 Knowledge public port 解析并向 Author/Reviewer 传递 SubjectProfile；
    MCP 仍返回合法软失败，但外层在写 scan 前重新抛出 probe outage，使 day claim 保持
    `claim + no scan` 并由 pg-boss 同日重试。增量 unit 1 file / 42 passed、DB 1 file /
    19 passed、typecheck、changed-file Biome、diff check 通过。
  - 20:47 用 mock 输入启动 canonical Opus real-output 复评；第一簇的 3 个独立
    induction call 均收到 429 weekly limit，按 operational stop condition 立即停止，
    没有把 fallback 或空输出记成质量结果。
- **YUK-814 闸门口径已按 owner 新决策修正**
  - 现有 harness 可继续用于真实 owner 观察数据，但它是扩大使用闸门，不是产品实施闸门。
  - synthetic/mock 仍不能冒充真实用户效果；但“mock 输入 + 真实模型输出”是合法的开发质量测试。

## NEXT

1. PR #1110 两条新 review findings 已在工作树修复。提交、推送、回复并清零 threads，
   合并最新 main 后，只监听新 exact head 的 GitHub CI Gate，不在本地跑全 gate。
2. 修复 head CI 全绿后合并 P0；再用固定 mock evidence packets 跑 canonical Opus real-output
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
- **YUK-820 live timing**：DB affected selector 已随 main 合并并完成 20/20 failed-head
  回放；仍等待下一条不触及 schema/migration/CI 自身的普通 server/API PR 验收 wall-clock。

## BLOCKED-ON

- **本次 P0 代码：无产品数据 blocker**；只剩新 review 修复的提交、thread 清零、
  main 冲突同步与 exact-head GitHub CI Gate。
- **canonical Opus 输出质量结论**：2026-07-29 20:47 实测被 429 weekly limit 阻断；
  配额故障只记 operational，不能用 Mimo fallback 的结果冒充 canonical pass。
- **auto-intervention 扩大使用**：仍需真实 owner/cohort shadow/blind/canary 证据；这是发布
  和扩量条件，不是继续实现功能的前置条件。
