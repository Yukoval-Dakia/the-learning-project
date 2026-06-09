# Copilot 架构实施路线图（2026-06-09）

> Status: **READY TO IMPLEMENT**。2026-06-09 grilling session 的设计全部 accepted（已 merge 进 main `d6d7f54b`）。
> 本文件把 4 个 ADR / 5 个 Linear issue 排成可实施阶段：依赖 DAG + 关键路径 + 并行机会 + greenfield 风险 + 起步建议。
> **设计门禁已满足**（全 拍）；**实现门禁**：UI 代码前先 design-doc pre-flight（CLAUDE.md）；新字段过 `audit:schema`；每 lane 独立 reviewer。

## 0. 输入（已 accepted）

| ADR | 主题 | impl umbrella |
|---|---|---|
| ADR-0031 | quiz C→A（copilot 内联出题）| **YUK-304** |
| ADR-0032 | DomainTool 面审查（34 工具 6 簇）| **YUK-303** |
| ADR-0033 | interactive 学习 artifact（沙盒 HTML）| **YUK-306** |
| 呈现层设计 doc | 6 载体 + primary_view + P3 tracker | **YUK-307** |
| — | composite 生成 → author_question；判分收窄留存 | **YUK-302**（re-scoped）/ YUK-212 |

设计 docs：`docs/adr/0031..0033`、`docs/design/2026-06-09-mcp-tool-design-review.md`、`docs/design/2026-06-09-copilot-presentation-layer.md`。

## 1. 依赖 DAG

```
                 ┌─────────────────────────────┐
                 │ A1  author_question core    │ ← 脊柱/keystone（YUK-303 D8）
                 │ (variant + write_question_   │   统一 runVariantGen +
                 │  draft + record_promotion→Q) │   actions.ts accept-materialize
                 └──────────┬──────────────────┘
            ┌───────────────┼───────────────────┐
            ▼               ▼                   ▼
   ┌────────────────┐ ┌──────────────┐ ┌─────────────────┐
   │ B quiz C→A     │ │ D interactive│ │ E composite-gen │
   │ (YUK-304)      │ │   artifact   │ │  (YUK-302 生成段) │
   │ blockedBy A1   │ │ (YUK-306)    │ │  → author_question│
   └────────────────┘ │ author_      │ └─────────────────┘
                       │ artifact 族  │
                       └──────────────┘
   ┌──────────────────────────────────────────────────┐
   │ A2  tool-surface 改（YUK-303 其余，互相大体独立）   │  并行
   │  copilot 全集并 / CP⁺ 溶解 / LI transition 收敛 /  │
   │  query_questions(包 YUK-280) / edge-archive /      │
   │  question 结构读 + propose_question_edit(建 YUK-281)│
   │  / attribution 用户错因+force_reattribute / var guard│
   └──────────────────────────────────────────────────┘
   ┌──────────────────────────────────────────────────┐
   │ C 呈现层组合层（YUK-307）                           │
   │  C1 caller 策略（轻，零结构依赖）：primary_view +   │  C1 可即起
   │     density + bespoke result 注册表 + ribbon 剂量   │
   │  C2 新基建：P3 async tracker（job_events 泛化 +     │  C2 需"有个后台 task 可追"
   │     /api/jobs SSE + 卡绑 run）+ agent_notes wire    │  → 跟在 B 或任一 async task 后
   │     (YUK-293)                                       │
   └──────────────────────────────────────────────────┘
   ┌──────────────────────────────────────────────────┐
   │ E' 判分收窄（YUK-302 / YUK-212）—— 完全独立         │  随时可落
   └──────────────────────────────────────────────────┘
```

## 2. 关键路径 + 并行

- **关键路径**：`A1 author_question` → `B quiz C→A`。author_question 是 quiz 内联出题的前提（YUK-304 blockedBy YUK-303）。
- **Day-1 可并行**（无结构依赖）：
  - **C1**（呈现层 caller 策略：primary_view / density / ribbon）—— 既有 `ToolUseCard` 已通用，纯 caller 侧。
  - **D 沙盒 iframe 基建**（greenfield，前导时间最长，越早起越好）。
  - **E' 判分收窄**（YUK-212，独立模块）。
  - **A2 tool-surface 改**（彼此大体独立的小 lane）。
- **跟随项**：
  - **B** 跟 A1。**D author/update 工具** 跟 A（author_artifact 族）。**E 生成段** 跟 A1。
  - **C2 tracker** 需要"有个后台 task 可追"——跟在 B（quiz 后台路径）或任一 async task 之后。

## 3. greenfield / 风险（lane-start 先解）

| 风险 | 说明 | 落点 |
|---|---|---|
| **沙盒 iframe（D，最高）** | 全仓零 iframe/sandbox 先例（仅 LoomIcon 可信 SVG）。`srcdoc`+`sandbox=allow-scripts` 去 same-origin + CSP 禁网。安全敏感 → 先建 + 威胁模型验证 | ADR-0033 / YUK-306 |
| **author_question 统一（A1）** | 必须保留现有 variant guards（cause-targetable/depth≤2/caps）+ accept-materialize 幂等（`actions.ts:1712/1393`）；别回归 mistake_variant 流 | YUK-303 D8 |
| **primary_view 管线（C1）** | 新信封字段穿过 `runCopilotChat`/`CopilotTask` reply 契约——触及 S3a turn 持久化，**别破坏**（YUK-267 防循环红线）| YUK-307 |
| **job_events 泛化（C2）** | runner 为 ai_task_runs 发 job_events；**run_id 须 enqueue 时预铸**（ai_task_runs 行常晚于 enqueue 提交）| YUK-307 / P3 |
| **agent_notes wire（C2）** | `readAgentNotes('copilot')` 接进 run input 必须守防循环注入红线（事实非装配物 / expires_at / 鲜读不回写 / 双截断）| YUK-293 |
| **HTML 存储位（D）** | `attrs.html` vs 新列——影响 `audit:schema`（新业务字段需 write-path 或 allowlist）| YUK-306 |
| **writeToolQuizArtifact core（B）** | quiz 组卷写与 `write_review_plan` 共享 core，**B 落地时抽**（不预抽，RP-2）| YUK-304 |

## 4. 建议起步

**首发三线并行**（launch-phase 隔离 worktree，各跑 impl→review→fix→gate）：

1. **A1 author_question core**（关键路径起点，keystone）。
2. **D 沙盒 iframe 基建**（greenfield 最长前导，越早越好；先只做"渲染一段可信 HTML 进沙盒"的最小闭环 + 威胁模型验证，author/update 工具跟 A）。
3. **C1 呈现层 caller 策略**（primary_view + density，轻、零结构依赖，早落早能验证呈现）。

A1 绿后解锁 **B quiz**；A2 surface 改作为一组小 lane 穿插；E' 判分收窄任意空档落；C2 tracker 跟在 B 后。

## 5. 门禁 reminder（每 lane）

- **UI pre-flight**：任何 UI 代码（呈现层卡片 / 面板 / interactive 渲染）前，先逐字引用 design doc 段落 + 声明组件类型 + 列 touch 文件，等批准。
- **gate**：`pnpm typecheck / lint / audit:schema / audit:partition / audit:profile / test / build`。
- **新字段**：过 `audit:schema`（HTML 存储列、任何新列）。
- **独立 reviewer**：每 lane 完成派独立 opus reviewer 审 diff（不自审）。
- **Linear**：lane 用 `yuk-3xx-...` 分支；commit `Closes/Refs YUK-3xx`。

## 6. 状态

设计全 merge（main `d6d7f54b`）。本路线图 = 实施前的排序与风险清单；**未开 impl lane**（等指令）。
