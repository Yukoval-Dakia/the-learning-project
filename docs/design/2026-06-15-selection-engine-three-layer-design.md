# 调度选题引擎 · 三层形态（ADR-0037 欠规约落地 + MFI 嵌入）

**Date**: 2026-06-15（**rev 2** — 独立 critic pass 后修订；4 视角纯文本 critic，450k tokens）
**Status**: **Design-in-progress**（三层形态 + MFI 信号位 + order 切分 收敛；~14 待规约 blocker + 2 owner 决策点）
**Part of**: AI pipeline re-think · 调度轴 B3 · D14 编排面。把 ADR-0037（合并引擎）banked 的架构裁决，落地成「产出今日流的选题引擎」具体形态，并嵌入 MFI（最大 Fisher 信息）强自适应作 L1 信号维度。
**Decision source**: owner 2026-06-15 逐问压实 ——「上 MFI 强自适应怎么做」→「MFI 会怎样改造现有选题」→「新设计里的选题引擎」→「落成 design doc」。
**Grounded on**: ADR-0037（合并引擎）· ADR-0030（variant-rotation 子步骤）· `variant-rotation.ts:231` / `due-list.ts:234-322` / `review-plan-tools.ts:204` · B1 foundation doc §5.3（MFI capitalization）· urnings-elo 核验（MFI 下 Elo 优于 Urnings）· 决策总账 §6 ⑥⑦（反舒适区 + fatigue + review_format 第二维）。
**critic 修订（rev 2）**: 三视角收敛 → **order 从 L2 切出（到期序归 L1+L3，非到期穿插归 L2）**；§4 三轴定义修正（MFI 是交叉派生非第三轴）；补 §6⑥⑦；新增 L3 invariant 全集 + 责任分配表；fallback 退化到 `composeDailyStream`（非纯 due）；H8 补回显式化；recall 类不喂 MFI。

**Related**: ADR-0037（合并引擎）/ ADR-0030（variant-rotation 子步骤）/ ADR-0035（mastery_state θ̂/b 来源）/ ADR-0028（FSRS *when* 只读）/ ADR-0039（A/B/C）/ ADR-0041（copilot reach）。

---

## 0. 问题

ADR-0037 拍板了调度合并引擎的**架构裁决**（一 AI 引擎吃 5 输入；FSRS *when* 不并进；到期 hard constraint；frontier 一等公民；review_plan 退役），但代价节明列 **「三约束具体形态欠规约（blocker）」** ——「选题引擎怎么把 5 维输入合并成今日流决策」从未落地。本文补这块。rev 1 后经 4 视角 critic 发现**最大的架构破口是 order**：原设计让 L2 管 what+mix+order，但三个独立视角证明 order 里「到期项相对序」是 FSRS when 契约，交给 LLM 会被重排成 `is_due` 布尔（破正交）。rev 2 把 order 切开。

## 1. 三层三明治（rev 2 — order 切分）

核心张力：ADR-0037 要「AI 编排」，但 MFI/due/frontier 是确定性数学、硬约束不能交给 LLM 软化（B6）。解 = 确定性算信号喂 LLM、LLM 只编排需要判断的、确定性 post-filter 守 invariant。**rev 2 关键修正**：order 不全归 L2——**到期项相对序是 FSRS when 契约，L1 确定性算 + L3 保序守；非到期项（frontier/巩固）的穿插归 L2 mix**。

```
┌─ L1 确定性信号层（非 AI）────────────────────────────────────────┐
│  • FSRS due 列表      material_fsrs_state WHERE due_at<=now（只读，when 真相源）│
│  • frontier 候选      递归 CTE prerequisite-gating（depth-limited + cycle guard）│
│  • 每题 MFI score     f(|b_q − θ̂_kc|)，b=item_calibration，θ̂=mastery_state     │
│    （recall 类知识点【不喂】 per-question MFI —— 信号源头切断，守 ADR-0030）   │
│  • mastery p(L)       mastery_state（B1 校准 θ̂，gated；B1 前用 evidence_count）│
│  • 到期项【确定性保序排序】 due_at ASC（→ L2 不可重排到期相对序，FSRS when 契约）│
│  • 变式家族+路由      variant-rotation recall/application（ADR-0030 子步骤）    │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
┌─ L2 LLM 编排层（AI 编排引擎，D14 下）─────────────────────────────────┐
│  输入：L1 候选 + 保序的到期序 + mastery + mem0 prior（只读软提示，ADVISORY_ONLY）│
│  产出（职责收窄 rev 2）：                                                     │
│    • what：非到期候选主推哪些（到期项铁定入流，不归 LLM 决定 in/out）          │
│    • mix：非到期项（frontier/巩固）如何穿插进到期序 + 新知/巩固配比           │
│    • reason：每条 AI 理由（可解释留痕）                                       │
│  【不再决定】到期项相对序（L1 已定）、到期项 presence（L3 硬守）             │
└──────────────────────────────┬────────────────────────────────────────────────┘
                               ▼
┌─ L3 确定性 post-filter（非 AI，守 invariant 全集）──────────────────────────┐
│  • 到期 presence（H8）：漏了→显式补回（调 ADR-0030 pickProbeForKnowledge，   │
│    补到尾部 + 标 source:'due_override'；不看 LLM reason）                    │
│  • 到期保序（FSRS when）：到期项必须 due_at ASC，非到期穿插有界延迟 ±k 位     │
│  • recall invariant：recall 类 question_id === last_question_id（断言失败→   │
│    强制原题 + source:'recall_override'）                                     │
│  • 反舒适区（§6⑥）：每日必含 ≥1 frontier/transfer，不得全是高 p(L) 巩固     │
│  • fatigue/repetition 惩罚（§6⑥）：mix 软层 cap 连续同类                     │
│  • review_format 第二维（§6⑦）：B3 mix 输出按 5 分类穿插                     │
│  • draft 排除（Guard-B）+ 变式家族边界（MFI 不跨 family）                    │
│  • frontier 配额：count(frontier) ≥ max(1, floor(N×ratio))；LLM 填充临时边   │
│    cap 占比（如 ≤20%，标 source:'llm_filled'，E4 软建议不硬 gating）        │
│  • 配比 cap（防 LLM 全堆新知/巩固）+ 幻觉 id 剔除                             │
│  • fallback：LLM 挂/格式坏 → 退化到现有 composeDailyStream（多源确定性，     │
│    非纯 due——保留 frontier 确定性部分；语义违规> N 条→整体 fallback）       │
│  → 物化进 practice_stream_item（每条带 source + reason + 结构化 signals）    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**为什么切 order**（三视角收敛）：到期项推迟一位 = 实际拖延复习 = 破 FSRS when 契约（signal-fidelity）；L1 排序 vs L2 order 职责重叠会让 LLM 要么名存实亡要么无护栏（gap-hunt A3）；order 是 mix 的一部分但到期相对序受 when 约束（constraint-guard）。切法：**L1 算到期保序 + 非到期候选池，L2 编排非到期穿插，L3 守保序不变量**。这同时提 L2 可测性（order 确定性可测，what/mix/reason 才是 LLM 真正的活）。

### 1.1 L3 invariant 全集 + 责任分配（gap-hunt A1）

| invariant | 断言形式 | 责任 | 违反处置 |
|---|---|---|---|
| 到期 presence（H8） | 每 due 知识点 ∈ 流 | L3 post-filter | 补回（pickProbeForKnowledge，source:due_override） |
| 到期保序（FSRS when） | 到期项 due_at ASC + 有界延迟 | L1 预防（排序）+ L3 守 | L3 重排到期簇 |
| recall 不换题（ADR-0030） | recall 类 qid === last_qid | **L1 预防**（recall 不喂 MFI）+ L3 守 | 强制原题（source:recall_override） |
| 反舒适区（§6⑥） | 流含 ≥1 frontier/transfer | L3 post-filter | 补 1 个 frontier |
| frontier 配额 | count(frontier) ≥ floor(N×ratio) | L3 post-filter | 补 frontier |
| 临时边占比（E4） | llm_filled ≤ cap | L3 post-filter | 裁超 cap |
| 唯一性 | (date, ref_id) 唯一 | DB constraint（onConflict） | 静默去重 |
| 容量 | 流长 ≤ DEFAULT_MAX | L1 截断（影响 LLM 看到什么） | L1 二次截断 |
| draft 排除（Guard-B） | draft_status != 'draft' | L1 预防 | WHERE 过滤 |

**原则**：能 L1 预防的不留 L3 守（recall 不喂 MFI、draft 过滤、容量截断）；只能结果层守的才 L3（presence、保序、配额）。

### 1.2 H8 补回机制（constraint-guard #2 修订）

L2 若漏列到期项（幻觉/context 不够/主动决定不列），L3 presence 断言失败 → **显式调 ADR-0030 `pickProbeForKnowledge` 补回该知识点**（复用现有选题逻辑，recall invariant 在补回路径也守住），补到流尾部，标 `source:'due_override'`（与 L2 主动编排项区分，避免用户看 reason 时矛盾——LLM 说「不必复习」但出现了，标注说明是系统兜底）。

## 2. MFI 作为 L1 信号维度（嵌入 banked 5 输入）

**MFI 数学**：Rasch/1PL 下 Fisher 信息 `I(θ)=P(θ)(1−P(θ))`，θ=b 时最大。**MFI = 选 `argmin |b_q − θ̂|`**。

**载体依据（urnings-elo 核验）**：MFI 强自适应下 **Elo（b 锚死）优于 Urnings**——Urnings adaptive-selection 校正要 O(|items|) 重算选题分布 + mandatory MH（divide-by-zero 边界），闭式 SE 在 n=1 small-N 退化；Elo fixed-adaptive 有 negative bias（p>0.5 偏低）但 O(1)、已知可控。**回应 B1 §5.3**：B1 地基列 Urnings 的 adaptive 校正为优势，但在 MFI 作日常调度信号（非仅自校准）场景下，O(|items|) 重算 + MH 退化使 Elo fixed-adaptive 成为可接受折中；此选择不 amend ADR-0035（0035 未拍 Elo vs Urnings），仅在本 design doc 的 MFI 信号位上下文生效。

**多 KC 题 θ̂ 取法（signal-fidelity #5 补）**：`knowledge_ids jsonb[]` 多 KC 题，MFI 用 **θ̂_min = min(kc.θ̂)**（最薄弱 KC）——理由：一题的杠杆在其最薄弱环节的恢复。**须与 mastery VIEW 的多 KC 聚合规则协调**（若 VIEW 报 avg 而 MFI 取 min，杠杆轴与混合轴读同一题会不一致）。

**recall 类不喂 MFI（constraint-guard #3 修订）**：L1 对 recall 类知识点**不喂 per-question MFI score**（信号源头切断），否则 MFI 会推 LLM 给 recall 类换题，破 ADR-0030 原题重复 invariant。MFI 只喂 application 类候选。

## 3. 产出结构（what/mix/order/reason → practice_stream_item）

每条 `practice_stream_item`：
- **what**：knowledge_id/question_id + 来源（due / frontier / 巩固）
- **mix role**：block vs interleave / 新知 vs 巩固占比（B1 p(L) 阶段驱动；B1 前用 evidence_count，见 §5）
- **order**：呈现序（**到期序 L1 定，非到期穿插 L2 定**）
- **reason**：AI 理由
- **source**：`llm` / `due_override`（L3 补回）/ `recall_override`（L3 纠正）/ `llm_filled`（临时 frontier 边）
- **signals（结构化 jsonb，rev 2 新增）**：mfi_score / due_urgency / frontier_depth / cap_hit_reason —— **不只塞 reason 文本**（gap-hunt D1：观测可查询性）

## 4. 守住 banked 约束（映射，rev 2 修正）

| 约束 | 来源 | 怎么守 |
|---|---|---|
| FSRS *when* 不并进 AI（正交 R 轴） | ADR-0037 决定 2 | L1 只读 due + 确定性保序；L2/L3 不碰 when 数学；到期相对序 L1 定 |
| mix 驱动今日 what 组成，不回写 when | （rev 2 显式声明） | mix 改的是非到期穿插 + 配比，when 真相源仍是 `material_fsrs_state.due_at` |
| 到期 hard constraint | ADR-0037 H8 | L3 presence 断言 + 显式补回（§1.2） |
| frontier 一等公民 | ADR-0037 决定 4 | L1 递归 CTE + L3 配额 ≥floor(N×ratio)（防 LLM 输出 0 frontier） |
| mem0 只读软提示不进数值 | ADR-0037 H5 | L2 进 prompt 标 `ADVISORY_ONLY`；不可机械验证（见 §5 天花板）；L3 due presence 是唯一硬兜底 |
| 三轴正交 | ADR-0037/0035 | R / p(L)+transfer / difficulty；**MFI 是 difficulty×p(L) 的交叉派生信号，非第三轴**（rev 2 修正 §4 曲解） |
| recall 不污染 | **ADR-0030**（经 0037 决定 1 降为子步骤） | L1 不喂 recall 类 MFI + L3 recall 断言 |
| 反舒适区 + fatigue + review_format 第二维 | 决策总账 §6 ⑥⑦ | L3 post-filter（rev 2 补，原 doc 漏接） |
| fallback 退化态 | ADR-0037 B6 | 退化到 `composeDailyStream`（非纯 due，保留 frontier 确定性部分） |

## 5. 诚实天花板（rev 2 扩）

1. **capitalization on chance**（B1 §5.3）：θ̂ 不准 MFI 系统性偏好 a/c 误差题。缓解：b 锚死、θ̂ SE 宽降权、cap 曝光率 + **观测 cap 触发率**（§3 signals 列）。
2. **MFI 锚质量上限**：b 来自 LLM 先验（B1 §7.4 G3 弱地基）。
3. **LLM 软化硬约束**：L3 代码硬裁不看 reason；但用户看 reason 可能见矛盾 → source 标注（§3）区分系统兜底。
4. **MFI 喂 LLM 失真（signal-fidelity #1）**：LLM 对 prompt 原始浮点不敏感，MFI 可能「被携带但未被使用」。**rev 2 缓解**：order 收回 L1（MFI 进确定性保序而非 LLM 编排）+ MFI 在 prompt 分桶（high/mid/low）+ 诊断日志记「输入最高 MFI vs 输出排第一」排名差。
5. **mem0 软约束不可机械验证（rev 2 新增）**：LLM 可能把 mem0 prior 当硬偏好影响 what/mix，即便 H5 声明不进权重。缓解：prompt 标 `ADVISORY_ONLY` + L3 due presence 兜底。
6. **mastery B1 前偏斜（rev 2 新增，signal-fidelity #4）**：未校准 VIEW 对 evidence<3 给保守默认 → frontier KC 读为低掌握 → 巩固偏见反馈循环（frontier 永不解锁）。**缓解**：B1 前用 evidence_count 驱动 mix（非 mastery_point）+ prompt 传播 is_placeholder 不确定性 + 明标 B1 前 mastery 是已知粗糙信号。

## 6. 待规约 blocker（rev 2 扩到 ~14，分 5 类）

**运行时形态（gap-hunt B1-B3，最高优先——不定则其余悬空）**
1. **运行时形态**（owner fork）：nightly 预产 / on-demand 实时 / hybrid。θ̂ 实时性 vs 流预产张力。现状 lazy compose on first read。
2. **并发/竞态**（B2）：多 tab / copilot 并发 compose → 双倍 LLM 成本 + order 冲突。定 advisory lock / 单 flight / pg-boss 单例。
3. **候选窗 + token 预算**（B3）：L1→L2 候选总量上限（≤50？）+ frontier CTE LIMIT + 单次 LLM token 预算。

**数据契约（gap-hunt C1-C2）**
4. **L1→L2 数据契约 schema**（C1，比 prompt 契约更根本）：候选数/截断策略（截断即决策）/每候选信号向量/per-candidate vs global/缺失信号（θ̂/b 未标定时输出什么）。
5. **L2→L3 格式坏 vs 内容坏分**（C2）：格式坏→fallback；内容坏（幻觉 id/越界候选/配比超限）→ per-item repair 策略表。

**观测/调参（gap-hunt D1-D2）**
6. **观测面**（D1）：`practice_stream_item.signals` 结构化列（§3）+ capitalization 跨天检测 + cap 触发率 query。
7. **参数表**（D2）：mix/cap/降权阈值的（默认/调整粒度/观测信号/护栏层 warn vs hard）。

**测试（gap-hunt E1）**
8. **三层测试策略**（E1，近 blocker）：L1/L3 确定性层单测 + invariant 断言；L2 用 golden E2E + L3 invariant 兜底 + **owner 长期反馈（n=1 认识论约束——L2 编排质量不可单测，靠使用验证）**。

**衔接（gap-hunt F1-F3 + ADR 接口）**
9. **流生命周期**（F1）：compose（首次/夜间）/ advance（作答推进，不调 LLM 但改 θ̂→改 MFI）/ recompose（用户主动，调不调 LLM？）三态层调用。
10. **copilot reach 边界**（ADR-0041 漏接）：copilot 能否触发 compose 重跑 / 直接改 practice_stream_item（走 typed apply + checkpoint）/ 改后 L3 是否重执。
11. **今日流撤销链**（ADR-0039 接口）：practice_stream_item 不在 18 kind 归档表，撤销语义（删行/superseded/整流撤/逐条撤）未定义。
12. **frontier CTE cycle guard**（F3）：递归 CTE 必须 depth limit / cycle detection，否则脏 prereq 边挂掉引擎。
13. **mem0 prior 进 prompt 契约**（原 #3）：量级 cap + ADVISORY_ONLY 标注。
14. **MFI score 归一化 + f 形式**（原 #4，gap-hunt A2）：与 due 紧迫度的可比性契约。

## 7. 与 ADR 的关系（rev 2）

- **ADR-0037**：本设计是其选题引擎组件形态落地；不改架构裁决。
- **ADR-0030**：variant-rotation 降为 L1 子步骤；recall 来源标 0030（非 0037）。
- **ADR-0035**：mastery_state（θ̂）+ item_calibration（b）= MFI 数据前置，gated B1 载体。
- **ADR-0039**：今日流产出档位 + 撤销链（blocker 11，未对齐 0 A 归档表）。
- **ADR-0041**：copilot reach 边界（blocker 10，漏接）。

## 8. 状态 / owner 决策点

三层形态（确定性信号 → LLM 编排 → 确定性约束）+ MFI 作 L1 信号 + **order 切分（到期序归 L1+L3）**收敛（rev 2 critic 修订）。14 待规约 blocker 留实施前定。

**两个 owner 决策点（critic 提出，需拍）**：
- **决策点 A（运行时形态，blocker 1）**：nightly 预产 / on-demand 实时 / hybrid。这是最根本的形态 fork，定 L2 成本/并发/缓存模型。**推荐 hybrid**（nightly 骨架 + 作答后增量重排，平衡 θ̂ 实时性与成本）。
- **决策点 B（ADR-0042？）**：MFI 从 B1 自校准手段提升为调度信号 + 三层三明治 + order 切分，是够格 ADR 的新架构选择（adr-consistency #2/#3）。**建议另开 ADR-0042** 固化追溯链；若 owner 坚持 design-doc-only，§0/§7 已留逐问压实原文作追溯。

数据前置（mastery_state + item_calibration）gated B1 载体 wave；过渡形态可用 `question.difficulty`（1-5）+ evidence_count 做 crude MFI 先 prototype。
