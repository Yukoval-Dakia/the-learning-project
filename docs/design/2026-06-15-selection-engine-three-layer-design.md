# 调度选题引擎 · 三层形态（ADR-0037 欠规约落地 + MFI 嵌入）

**Date**: 2026-06-15
**Status**: **Design-in-progress**（三层形态 + MFI 信号位 收敛；6 条待规约 blocker 待实施前定）
**Part of**: AI pipeline re-think · 调度轴 B3 · D14 编排面。本文把 ADR-0037（调度合并引擎）banked 的架构裁决，落地成「产出今日流的选题引擎」具体形态，并嵌入 MFI（最大 Fisher 信息）强自适应作为 L1 信号维度。
**Decision source**: owner 2026-06-15 逐问压实 ——「上 MFI 强自适应怎么做」→「MFI 会怎样改造现有选题」→「新设计里的选题引擎」→「落成 design doc」。
**Grounded on**: ADR-0037（合并引擎架构裁决）· ADR-0030（variant-rotation probe selector，降为复习侧子步骤）· `src/capabilities/practice/server/variant-rotation.ts:231`（pickProbeForKnowledge）· `src/capabilities/practice/server/due-list.ts:234-322`（候选池 + 排序）· `src/capabilities/practice/server/review-plan-tools.ts:204`（mastery-aware 仅展示）· B1 foundation doc §5.3（MFI capitalization on chance 警示）· `urnings-elo` 核验（MFI 下 Urnings 校正 O(|items|)，Elo fixed-adaptive 可控）。
**Related**: **ADR-0037（合并引擎——本设计是其中选题引擎组件的形态落地）** · ADR-0030（variant-rotation 降为子步骤）· ADR-0035（mastery_state 三维——θ̂/b 来源）· ADR-0028（知识级 FSRS *when*，只读约束）· ADR-0039（单编排者 + A/B/C——选题引擎在 D14 之下）。

---

## 0. 问题

ADR-0037 已拍板调度合并引擎的**架构裁决**（一 AI 引擎吃 FSRS due + frontier + mastery + mem0 + AI 判断；FSRS *when* 不并进；到期 hard constraint；frontier 一等公民；review_plan 退役）。但代价节明列 **「三约束具体形态欠规约（blocker）」** ——「选题引擎怎么把 5 维输入合并成今日流选题决策」从未落地成具体形态。本文补这块：**三层三明治（确定性信号层 → LLM 编排层 → 确定性约束层）**，并把 MFI（owner 拍的强自适应选题）作为 L1 的一个确定性信号维度嵌入 banked 的 5 输入。

## 1. 三层三明治

核心张力：ADR-0037 要「AI 编排引擎」，但 MFI / due / frontier 是确定性数学、硬约束不能交给 LLM 软化（§6.2 B6：prompt 软约束会被 LLM 软化）。解 = 确定性算信号喂 LLM、LLM 只编排、确定性 post-filter 守 invariant。

```
┌─ L1 确定性信号层（非 AI，算好喂 LLM）─────────────────────────┐
│  • FSRS due 列表      material_fsrs_state WHERE due_at<=now（只读，when 真相源，ADR-0028）
│  • frontier 候选      递归 CTE prerequisite-gating（新知 what 来源，ADR-0037 决定 4）
│  • 每题 MFI score     f(|b_q − θ̂_kc|)，b=item_calibration，θ̂=mastery_state  ← 新维度
│  • mastery p(L)       mastery_state per-knowledge（B1 校准 θ̂，gated 落地）
│  • 变式家族+路由      variant-rotation recall/application（ADR-0030 子步骤，降级保留）
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─ L2 LLM 编排层（AI 编排引擎，D14 之下）──────────────────────┐
│  输入：L1 候选 + mastery + mem0 prior（只读软提示，不进数值权重，H5）
│  产出：今日流 = what（主推哪些知识点/题）+ mix（新知/巩固/block-interleave 配比）
│        + order（呈现序）+ 每条 reason（可解释留痕）
│  LLM 决定【编排】，不算数学（MFI/due/frontier 已在 L1 算好作为信号喂入）
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─ L3 确定性 post-filter（非 AI，守 invariant）──────────────────┐
│  • 到期 hard constraint：LLM 只能改呈现/主推，不能从队列删（H8，落代码 invariant + 测试）
│  • recall invariant：fill_blank/translation 不换题（ADR-0030，FSRS 量的 recall item 不能污染）
│  • draft 排除（Guard-B）+ 变式家族边界（MFI 不跨 family）
│  • 配比 cap（防止 LLM 全堆新知 / 全堆巩固）
│  • fallback：LLM 挂了（超时/格式坏/空输出）→ 退化到 L1 纯确定性 due 队列
│  → 物化进 practice_stream_item（每条带 reason）
└─────────────────────────────────────────────────────────────────┘
```

**为什么三明治而非纯 LLM 或纯确定性**：
- 纯 LLM → 硬约束被软化（B6）、数学被幻觉、mem0 注入面大。
- 纯确定性加权 → 丢了 ADR-0037「AI 编排」主线（frontier 空时 LLM 填充、mix 按掌握阶段动态配比、mem0 软提示），退回 Phase 0 双脑。
- 三明治 = 确定性兜数学与约束，LLM 负责需要判断的编排（what 主推 / mix 动态 / reason 解释）。

## 2. MFI 作为 L1 信号维度（嵌入 banked 5 输入）

**MFI 数学**：Rasch/1PL 下 Fisher 信息 `I(θ)=P(θ)(1−P(θ))`，在 P=0.5 即 θ=b 时最大。**MFI = 选 `argmin |b_q − θ̂|` 的题** = 最诊断的题（owner 拍的强自适应）。

**在引擎里的位置 = L1 的一个确定性信号维度**：
- 不是 LLM 自己算（LLM 算幻觉）——L1 给每个候选题算好 MFI score 喂进去。
- 不是 hard constraint（不进 L3）——它是「诊断价值」信号，LLM 在 L2 把它和到期紧迫度 / frontier 推进 / mem0 软提示一起编排进 what/mix/order。
- 嵌进 ADR-0037 banked 的 5 输入里，是 `mastery p(L)` 维度细化出的「诊断增益」子信号：mastery 提供「掌握多少」，MFI 提供「这道题对当前能力的诊断增量」。

**载体依据（urnings-elo 核验）**：MFI 强自适应下，**Elo（b 锚死）优于 Urnings**——Urnings 的 adaptive-selection 校正要 O(|items|) 重算选题分布 + mandatory MH（divide-by-zero 边界），闭式 SE 在 n=1 small-N 退化；Elo fixed-adaptive 有 negative bias（p>0.5 偏低）但 O(1)、已知可控。故 θ̂ 在线更新用 Elo + b 固定外部锚。

## 3. 产出结构（what/mix/order/reason → practice_stream_item）

LLM 编排产出的今日流，每条 `practice_stream_item`：
- **what**：knowledge_id / question_id + 来源（due 复习 / frontier 新知 / 巩固）
- **mix role**：block vs interleave / 新知 vs 巩固占比（由 B1 p(L) 掌握阶段驱动，A2 流为脊柱）
- **order**：呈现序（主推靠前）
- **reason**：AI 理由（「诊断价值高 + 到期」/「frontier 推进前置依赖」/「巩固薄弱 KC」）——可解释留痕（evidence-first，runs log 到 `src/server/ai/log.ts`）
- **MFI score**：诊断价值数值（reason 的一部分）

## 4. 守住 banked 约束（映射）

| 约束（ADR-0037） | 怎么守 |
|---|---|
| FSRS *when* 不并进 AI（正交 R 轴，决定 2） | L1 只读 due；L2/L3 **不碰** when 数学；material_fsrs_state 仍是 when 单 writer |
| 到期 hard constraint（H8） | L3 post-filter：LLM 删不掉到期项，只能改呈现/主推（代码 invariant + 测试防 §6.3 C1 正交破口） |
| frontier 一等公民（决定 4） | L1 递归 CTE 作 what 来源；空 frontier LLM 填充在 L2（低置信 propose-only） |
| mem0 只读软提示不进数值（H5） | L2 进 prompt 上下文，不进 score 权重；编排者输出永不进 mem0 extraction 源（H6 防循环注入） |
| 三轴正交 | R=FSRS when / p(L)+transfer=mastery / difficulty=MFI，各自独立喂入 L1 |
| recall 不污染（ADR-0030） | L3 守：fill_blank/translation 重复同题，MFI 不换 recall 题 |
| fallback 退化态（B6） | L3：LLM 挂 → 纯 L1 确定性 due 队列（先做 fallback 兜底再叠 AI） |

## 5. 诚实天花板

1. **capitalization on chance（B1 foundation §5.3 教科书级）**：θ̂ 不准时 MFI 系统性偏好 a 正误差 / c 负误差的题，n=1 样本越小越严重。缓解：b 锚死外部锚、θ̂ SE 宽时降权 MFI 回退 deterministic due、cap MFI 曝光率。
2. **MFI 质量 = 锚质量上限**：b 来自 LLM 先验（B1 foundation §7.4 G3 弱地基）→ MFI 诊断增益天花板被锚封顶。
3. **LLM 软化硬约束风险**：即便 L3 post-filter，LLM 可能在 reason 里「劝」删到期项（软约束渗漏）。缓解：L3 是代码硬裁，不看 reason；到期项 presence 是 post-filter 断言。
4. **MFI 被稀释（MFI-in-merge 的代价）**：MFI 作为 L2 多信号之一会被到期/ frontier 稀释 → 纯诊断增益不如纯 MFI。这是「守 FSRS when 正交 + n=1 友好」换来的，非缺陷。
5. **frontier 空填充有效性（ADR-0037 §6.5 E4）**：冷启动 LLM 猜古文知识点先后序无验证，临时边只软建议不硬 gating，先埋点测吻合率。

## 6. 待规约 blocker（ADR-0037 代价节明列，实施前定）

1. **post-filter 裁剪/补齐规则**（L3）：LLM 产出少了到期项怎么补、多了怎么裁。
2. **fallback 触发条件**：LLM 哪种失败（超时 / 格式坏 / 空输出）退化到纯 due 队列。
3. **mem0 prior 进 prompt 的权重契约**（H5）：多少 prior 进上下文、防 §6.3 C2/C3 注入。
4. **MFI score 的 f 形式**：线性加权？cap 曝光率？θ̂ SE 宽时降权阈值。
5. **mix 配比**：block↔interleave 由 p(L) 掌握阶段怎么驱动（A2 契约）。
6. **LLM prompt 契约**：吃 L1 信号的格式 + 产出 what/mix/order/reason 的 schema。

## 7. 与 ADR / doc 的关系

- **ADR-0037**：本设计是其「选题引擎组件」的形态落地 + 6 blocker 规约；不改 banked 架构裁决。
- **ADR-0030**：variant-rotation 降为 L1 复习侧子步骤（recall/application 路由 + 家族轮换），MFI 增强其 application 分支。
- **ADR-0035**：mastery_state（θ̂ 来源）+ item_calibration（b 来源）= MFI 的数据前置，gated B1 载体落地。
- **ADR-0039**：选题引擎在 D14 单编排者之下；今日流产出是 A 档（自动 + 撤销）语境。
- **copilot reach/endurance（ADR-0041）**：独立轴，但今日流是 copilot 「规划」能力的直接消费者。

## 8. 状态 / 待续

三层形态（确定性信号 → LLM 编排 → 确定性约束）+ MFI 作 L1 信号维度 收敛。未 ADR 化（ADR-0037 已 Accepted 架构层，本设计是其实施形态细化，不单独 ADR）。6 待规约 blocker 留实施前定。数据前置（mastery_state + item_calibration）gated B1 载体 wave；过渡形态可用 `question.difficulty`（1-5）+ `knowledge_mastery` VIEW 做 crude MFI 先 prototype 验证手感。
