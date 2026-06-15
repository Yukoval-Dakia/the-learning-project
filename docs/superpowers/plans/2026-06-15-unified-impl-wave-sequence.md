# 统一实施波次序 — 跨三线（#47 copilot 全能 / #46 选题引擎 / YUK-363 event-sourcing）

**Date**: 2026-06-15
**Status**: Plan（owner 已拍三线方向：「启动 #47」+「#47 ∥ YUK-363」+「按大改造走」；本文是 HOW 层串行实施序，自驱推进、可随时 redirect）
**Part of**: YUK-203 epic。三条 design/map 线全部 grounded 收敛后的一次性跨线统筹。
**三线决策源**:
- **#47 copilot 全能** = ADR-0041（reach + endurance + checkpoint，已 Accepted + 2026-06-15 amendment）+ `2026-06-15-copilot-reach-endurance-design.md` + `…-checkpoint-draft-layer.md` + `…-ai-pipeline-current-map.md`。
- **#46 选题引擎** = ADR-0042（owner 拍：hybrid runtime + 三层三明治 + order 切分）+ `2026-06-15-selection-engine-three-layer-design.md`（rev2）。
- **YUK-363 event-sourcing** = ADR-0044（owner 拍「走大改造」）+ `2026-06-15-event-sourcing-foundation-redesign.md`。
**上游 gate**: `2026-06-15-rethink-implementation-gate.md`（rethink 设计阶段收口，owner 已 ratify §1.5/1.6/1.7）——本文是它「§5 下一步：算法/结构骨架起跑」的跨线落地序。

---

## 0. 北极星（裁所有 HOW 取舍，引 gate §0）

留存 / 成效 / 代理信任 / 认识论诚实 四条共存。三线对应：**#46 选题引擎** → 留存 + 代理信任（每天主动开来练 + 放心把「今天学什么」交给 AI）；**#47 copilot 全能** → 代理信任（AI 真够得着、跑得久、撤得回）；**YUK-363** → 认识论诚实 + 代理信任的地基（撤得回 = 信任的前提，evidence 可重算 = 诚实的前提）。

## 1. Grounding 修正（2026-06-15，重定波次依赖）

实施前对着 M5 后代码核验了「worker 完整性」这条原以为是 Wave 0 承重的共享前置，结论**大幅 de-risk**（证据 file:line 见 ADR-0044 §5 修正）：

| 原断言（ADR 文字） | grounding 结论 | 对波次的影响 |
|---|---|---|
| worker `causedByEventId` 透传 = 🔴 头号硬前置，优先级高于一切 | ❌ **已闭环**：type 字段在、同步面 + 所有现有 durable job 全透传、mirror writer 已读 ctx | 不再是独立 Wave 0 前置；新 copilot durable handler 照 quiz_gen 模式填即满足 |
| worker copilotTools half-wired = 硬前置、reach+endurance 双重承重 | ✅ 成立但**非功能阻断**：worker 靠 bootstrap CORE_TOOLS（superset 41）兜底，功能不缺工具，是 manifest 真相源对齐 | 降为 `start-worker.ts` 一行，**折进 #47 首发 lane**，不单列 Wave |
| copilot 无 durable job + job_events 基建 ~90% 现成 | ✅ 双双成立 | endurance 第 2 层是「照 quiz_gen 新建 handler」非从零造 |

**净效果**：原计划的「共享 worker 地基 Wave 0」基本已在 → 三线可更早各自起跑，#47 endurance 是最低风险首发。

## 2. 依赖图（实线=硬依赖，虚线=收束点）

```
B1 两表（mastery_state + item_calibration）= 已 merge #414 ✅
   │
   ├─→ #46 选题引擎（MFI/p(L) 信号读 B1 两表；L1 确定性→L2 LLM→L3 守）── 解锁 #45（π_i 持久化）
   │        product 脊柱 · 独立于 #47/YUK-363
   │
   └─→ YUK-363 Wave 0（θ̂/FSRS 快照可逆 + cascade CTE 骨架）── gated 在 ADR-0044 落地后

#47 reach 结构型 typed apply + run_task dispatcher 契约 + 单 applier choke point ─┐
   后端 · 独立                                                                    │
                                                                                  ├─(收束)→ #47 checkpoint（per-utterance PR）
YUK-363 cascade CTE 遍历器（Wave 0 引入） ───────────────────────────────────────┘    gated 在「单 applier」+「cascade」双就位

#47 endurance durable run（新 copilot_run handler 照 quiz_gen + worker manifest 接线 + 复用 job_events）
   后端 · 独立 · ~90% 现成 ── run card UI / summarize-continue 可拆后续 lane
```

**三个收束点**（决定串行序）：
1. **单 applier choke point**（#47 reach）= checkpoint 戳事件的唯一点 → reach 结构必须先于 checkpoint。
2. **cascade CTE 遍历器**（YUK-363 Wave 0）= checkpoint 的级联 revert 机制 → YUK-363 Wave 0 必须先于 checkpoint。
3. **π_i 持久化**（#46 选题引擎 L1）= #45 active-PPI rectifier 必需 → #46 必须先于 #45（且 #45 还 gated 在 owner 真实作答数据攒够，阶段③）。

## 3. 波次序（串行 gate，「一次盯一条」；owner「∥」= 跨 epic 交错 lane 非并发开多个重 workflow）

| Wave | lane | epic | 依赖 | UI? | 备注 |
|---|---|---|---|---|---|
| **W1（首发）** | copilot endurance durable run（后端） | #47 | 无（main 现成 job_events） | 否 | 桥同步→异步；新 copilot_run queue+handler 照 quiz_gen；折入 worker manifest 接线 |
| **W2** | 选题引擎三层（L1 确定性 + L2 LLM + L3 守 + hybrid runtime 骨架） | #46 | B1 两表✅ | 否（产 practice_stream_item，展示面归 form-axis epic） | product 脊柱；14 blocker 实施前在 lane plan 逐条定；持久化 π_i 兑现 #45 前置 |
| **W3** | reach 原语（run_task dispatcher 契约 + 结构型 typed apply + 单 applier choke point + propose_* rename） | #47 | 无 | 否 | 收束点①；rename 连带 allowlists/manifest/bootstrap/测试计数 |
| **W4** | YUK-363 Wave 0（θ̂/FSRS 快照可逆 + cascade CTE 骨架） | YUK-363 | ADR-0044 落地（PR #416 merge） | 否 | 收束点②；最低风险试点（单写者已就位 + invariant 审计已强制） |
| **W5** | YUK-363 Wave 1（knowledge/edge 真 fold + #1 materialized_ids + ADR-0034 一致性闸） | YUK-363 | W4 | 否 | 结构 projection 重算引擎首张 |
| **W6** | checkpoint（per-utterance PR + 级联 revert 编排） | #47 | W3 + W4（双收束） | 是（run card / PR diff 审）→ 先后端契约，UI 走 claude design handoff | 三腿收束于一处 |
| **W7+** | YUK-363 Wave 2/3（goal/mistake/learning_item → artifact+structured 合 YUK-358）· #47 summarize-continue · endurance run card UI · #45 π_i 去偏（阶段③，gated owner 数据） | 混 | 各自前置 | 部分 | 长尾，按需求拉起 |

**为什么 W1 选 endurance**：owner 点名「启动 #47」；grounding 证 ~90% 现成 + 纯后端 + 加性（不重构高风险 reach 面）+ 照 quiz_gen 既有模式 → 风险最低、立刻动得了、把 worker manifest 接线（唯一真残留缺口）顺手补掉。reach 重构（W3，触及五处手接线 + rename）押后到契约更稳。

**为什么 W2（#46）紧跟**：product 脊柱、独立、直接服务北极星「留存 + 代理信任」、解锁 #45。owner「∥」精神 = #47（W1/W3/W6）与 YUK-363（W4/W5）交错推进，#46 作独立产品线插入。

## 4. W1 首发 lane scope（交 lane plan 现场细化，不预写）

**deliverable**: copilot 能把长任务从同步 `streamTaskCollecting` 桥到异步 durable pg-boss run，进度经现成 `job_events` 流回。
**后端纯改，无 UI**（run card 订阅 UI = 后续 lane，需 design-doc pre-flight）。
**核心件**（lane plan grounding 后定准）:
- 新 `src/server/boss/handlers/copilot_run.ts`：照 `quiz_gen.ts` 工厂形态（`buildMcpServerFromRegistry` + ToolContext 填 `causedByEventId: triggerEventId`）。
- copilot chat 路由：长任务路由判定 → `boss.send('copilot_run', …)`；短活仍 inline（sync/async 阈值先粗，实测后调）。
- run handle = checkpoint_id（user_ask event id）；进度 `writeJobEvent(business_table='copilot_run', business_id=run_id)`；状态从 replay 派生（几乎不新表）。
- **worker manifest 接线**：`start-worker.ts` 调 `registerCapabilityCopilotTools(capabilities)` 对齐 `server/index.ts:43`（真相源对齐，顺手补）。
- interrupt/queue 单线程串行化（n=1，照 Claude Code，不并发）。
**拆出后续 lane**（不进 W1）：summarize-continue（改 runner throw 行为）、抬交互 caps、run card UI、reply_delta 持久化粒度分叉、sync/async 阈值实测。
**gate**: `pnpm typecheck/lint/audit:schema/audit:partition/audit:profile/test/build` 全绿 + 独立 Opus reviewer 审 diff + 关联 Linear（YUK-203 epic 下建 #47 实施子票）。

## 5. 与 rethink-implementation-gate / form-axis epic 的关系

- gate §1.5.1《端到端冒烟验收表》5 接缝（②a-e）= 跨 Wave 横切验收，**不属任一 lane 独占**：②b 判定→p(L) 单写路径 + ②c mastery event 回填随 W2/W4 落；②d 反向断言已实现（gate §1.5）；②a 录入→图谱、②e mem0 可恢复 = 独立 follow-up。
- gate §2 form-axis epic（A1-A4 + /knowledge 探索面 + 成效趋势面 + mastery 展示 ⑥ handoff 硬约束）= **claude design handoff 轨**，与本文后端波次**并行另起**，不在本串行序内。W2 产 `practice_stream_item` 的展示、W6 run card / PR diff 审的视觉都走那条轨。
- 本文只管**后端/算法/结构骨架**的串行实施序；像素层一律 form-axis epic + claude design。

## 6. 诚实天花板汇总（三线各自的成本买不动边界）

- **#47**: mimo-v2.5 长程连贯性（endurance 基建 ≠ 质量）；通用原语放大注入面（五防承重）；approve-before→revert-after 有「改了才撤」窗口（n=1 可接受）。
- **#46**: capitalization on chance（θ̂ 不准 MFI 偏好误差题）；MFI 锚质量上限（b 来自 LLM 先验）；L2 编排质量不可单测（靠 owner 长期使用验证）；B1 前 mastery 偏斜（用 evidence_count 过渡）。
- **YUK-363**: 真 attempt / FSRS 入册 / user_verified 块撤不掉（retract = 篡改用户真实历史）；θ̂/FSRS 快照只能倒带不能「抽中间留后续」（owner 否决重放）；per-utterance 窗口越久不可逆下游越多。

## 7. 状态 / 下一步
W1（copilot endurance durable run 后端）起跑实施。本文随 owner redirect 或 Wave 收尾回填进度。
