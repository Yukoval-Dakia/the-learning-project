# 产品重想 · 实施前收口（implementation gate）

**Date**: 2026-06-15
**Status**: Draft for owner ratification
**前序**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md`（最高权威总账）+ Phase 0/1/1.5/2 六文档 + ADR-0034~0039。
**触发**: owner 反问「你确定 rethink 结束了？」→ 114-agent / 13-镜头 completeness-critic 审计（覆盖图 46 维 / 29 open；产品全面图 10 面 / 15 跨切；98 候选缺口 → 对抗验证剔 30 → **68 条真账**，0 blocker / 17 high / 46 medium / 5 low）。

裁定：**rethink 作为「设计/决策」阶段未收口（~85%），但 0 blocker——骨架可立即起跑**。不能算完成的两条结构性原因 = ①全局裁决锚真空 ②端到端环从没被当「一个环」缝过。本文把「实施前必决」收口，并把形态轴 / 可延后项归位。

---

## §0 北极星裁决锚（owner 2026-06-15 拍定）

此前重想全程无产品级成功判据（north-star grep 零命中），ledger §0 六条全局原则全是 HOW 约束。owner 现拍定锚，作为后续**所有 HOW 取舍**（克制多克制 / 慢热多慢 / E1 开放题天花板能不能忍 / scope / gate 矛盾）的仲裁依据：

**成功判据（四条全要，不可为某一条牺牲另一条）**
1. **留存** —— 好到我每天主动开来练，而非建完吃灰。
2. **成效** —— 用一段时间后，某科相对我自己的趋势真的在涨。
3. **代理信任** —— 信任到放心把「今天学什么」交给 AI 编排。
4. **认识论诚实** —— 它不确定 / 判不准时如实告诉我，而非给我虚假确定。

> **操作规则**：四条共存；两条冲突时（如「克制策展」服务代理信任 ↔「多暴露信息」服务认识论诚实）**逐案 surface 给 owner，不预设静态排序**。

**自建存在理由（四条差异化共同成立 → 才构成「自建 > 拼装 Anki+ChatGPT+Notion」）**
- **统一认知图谱**：错题/笔记/掌握长在同一棵结构树上，拼装方案各自为政做不到。
- **AI 单编排者**：AI 替我做编排劳动（选题/排序/盯进度）；Anki 要自己设卡、ChatGPT 无长期状态。
- **慢热掌握诊断**：个性化自校准的「我到底会不会」，比 FSRS 调度 + 一次性人工判分更准、更持久。
- **诚实可追溯**：evidence 留痕、可回滚、不黑箱；AI 每个决策都能查到依据。

---

## §1 实施前必决（A 组）—— 推荐稿，待 owner 批

> 标注：**【确认】** = grounding 后发现已落字/自然消解，只需 owner 点头；**【拍】** = 真开放、需 owner 实质决策；**【代办】** = 我在本分支即办（对齐已决策的 drift / 机械）。

### ① 北极星锚 —— 【已办】见 §0。

### ② 端到端环验收契约 —— 【拍】把 5 条跨阶段接缝钉成一页冒烟验收表
重想按面/按轴各自重设计（每面都对），但从没把「环」作为整体缝合验证。5 条真实未缝主缝，建议产出**一页《端到端冒烟验收表》**，每条 = 一个端到端验收项（实施时逐条闭合）：

| # | 接缝 | grounded 现状 | 验收项（建议） |
|---|------|--------------|---------------|
| a | 录入→图谱 | phase0 §3/R8：生成→入库闭环「未通」，auto-enroll 真入库分支从未跑；TaggingTask 结构上无法为树上不存在的知识点建节点 | 新题被标 `knowledge_ids` → 知识点不存在则建节点 → 进 frontier 可达范围，三步端到端绿 |
| b | 判定→p(L) 单写路径 | R⟂p(L) 升为红线（synthesis §4.1），但「各管各」指估计互不写回，≠ 输入写路径已设计 | submit 时谁触发 PFA 更新、transfer credit CTE 何时跑读哪批 event、`judge_retraction`/D15 重判如何回滚已计入的 success/fail |
| c | mastery_state event 回填 | B1 把 `knowledge_mastery`（即时算 view）→ `mastery_state`（物化表）；event 是 SoT 但无 replay 路径 | 公式调参（PFA β/γ/ρ、半衰期换先验）时「从既有 event 重算既有知识点 p(L)」动作有定义，不静默只对新 event 生效 |
| d | 新承重墙表锁步进备份 | **已验真**：`archive.ts:32-61` 的 lockstep 守卫只单向校验 FK_ORDER→schema（FK_ORDER 里的表必须有 pgTable，否则 throw），**反向不校验**——新建 pgTable 不加进 `FK_ORDER` 就静默掉出备份，零 test/lint 拦 | `mastery_state`/`item_calibration`/`misconception`×2 进 `FK_ORDER`；**补一条反向断言**（每张业务 pgTable 必须在 FK_ORDER 或显式排除 allowlist，仿 `audit:schema`），杜绝下次再漏 |
| e | mem0 承重 prior 可恢复性 | `archive.ts:295` 备份「restore 从空记忆后端开始」；B4 把 mem0 升格为编排者每条主线的承重 attention prior | mem0 collection 纳入备份/恢复，或显式裁定「prior 可丢、restore 后冷启重建」并写明降级语义 |

> 我的推荐：②a/②b/②d 是真承重（影响数据正确性与不可买回资产），建议进 Wave 0；②c/②e 可与首个写真实状态的 Wave 并行。**②d 的反向断言我可以本分支直接实现**（纯防御性 lint，不碰备份语义），其余进验收表。

### ③ H 级架构 sign-off —— 大部分【确认】，真开放仅 H10【拍】
- **H1（B1 vs B3 排序层二选一）** —— 【确认】**伪二选一**：ADR-0037 决定#2 已定「B3 合并引擎决 what+mix（mix 由 B1 p(L) 掌握阶段驱动）、FSRS 决 when」。B1 p(L) 是 B3 的**输入**，不是竞争排序层。建议确认「B3 为唯一排序层，B1 为其输入」，H1 消解。
- **H2（合并引擎 supersede ADR-0029）** —— 【确认】**已正式落字**：ADR-0037 有完整「§与 ADR-0029 的关系（amends）」节——显式 amends 决定 4（Coach→brief→ReviewPlanTask 两级流水线被合并引擎取代）、review_plan 退役、明写「是推翻已锁决策的真重构，不是『接通』」，保留 0029 决定 1/2/3/5/6。无开放项，确认即可。
- **H3（bi-temporal 落字）** —— 【代办】**已决 + doc 漂移**：ADR-0034 已记「consistency gate supersedes bi-temporal」（方向与 project memory 一致），但 `2026-06-13-memory-architecture.md` 行 149/161/178/196/218 仍按 bi-temporal 描述 P4。**我在本分支对齐**：这些 P4 段加 superseded-by-ADR-0034 注 + 指向 YUK-344。
- **H10（difficulty 共享桥语义）** —— 【拍】**真开放**：三轴正交红线（R⟂p(L)⟂difficulty）在 difficulty 处需 ADR 钉死语义。建议：**difficulty（`item_calibration` b/θ）= 单 writer（标定 job）产出的只读共享输入**；p(L) 先验与任何 difficulty-aware 逻辑只**读**它，谁都不从另一轴写回——「共享输入」而非「共享估计值」，否则 p(L)↔difficulty 互写会破红线。建议落为 ADR-0035 amendment。**待 owner 拍这条语义**。

### ④ 故障/降级态的契约级语义 —— 【拍】（像素层归 claude design，契约层需现在定）
故障态被自承为头号横切缺口、被采纳为「每 Wave deliverable 必备项」，但只到治理原则。其中**直接决定写进 `mastery_state`/B1 锚集的内容、必须实施前定**的三条：
- **verify 闸第四档「练而不测」**：低置信题可练，但**不进掌握度估计、不进 B1 锚集**（已采纳，但 YUK-350 验收只字未提——须写进工单验收标准）。
- **引擎 fail-closed 降级**：标定崩 / 引擎挂时，mastery 退回什么状态（建议：退回纯先验 + 标低置信，绝不静默喂决策）。
- **`judge_retraction` 回滚规则**：撤销已喂进 p(L) 的证据时的 decrement/recompute 语义（与 ②b 同源）。

> 推荐：这三条写进对应算法工单（YUK-349/350）的**验收标准**，否则会被实施者忽略。其余故障态（空流/标定崩时屏幕上显示什么）= 形态轴，归 §2。

### ⑤ note_verify 是否并入 B5 统一 verify 契约 —— 【拍】
**已验真**：存在第四套信任闸 `src/capabilities/notes/jobs/note_verify.ts`（产出 `NoteVerificationResult`，`core/schema/business.ts:298`），结构同型于被 B5 收敛的三套（`server/boss/handlers/{source,quiz,variant}_verify.ts`）——都是「AI 二次信任 pass + verify-then-promote」。B5/ADR-0038 宣称「一处定义、可统一单测、可统一观测」却只收敛了三套。
> 推荐：**并入**（同型，且 AI 产物可信度是认识论诚实锚的落地面）。除非 owner 以「笔记不 enroll 进练习池 / 风险等级不同」**带理由排除**——但即便排除也须在冻结统一 verify schema 前显式记一笔，否则 B5 核心承诺带着未审计的第四实例出货。**待 owner：并入 or 带理由排除？**

### ⑥ prior-echo 可信度对 owner 可见 + 诊断丰富度下钻面 —— 【拍】（功能规约，非像素）
「实例化≠可信」红线全部防线（`confidence`/`track`/`source` 列 + allowlist 注释 + ADR 文字）都写给读代码的人；owner 在 /today 看「掌握 0.4」无法当场分辨这是真实作答校准（硬轨 firm up）还是 LLM 先验原样回吐（prior-echo）。同时四引擎全实例化付了真实成本，其唯一「对 owner 当下有用」的理由——下钻看 CDM attribute 画像 / IRT 区分度——从没设计任何下钻面。这两条是 mastery 展示 UI（claude design handoff）的**功能约束输入**，须先由 owner 定**呈现什么、下钻交付什么**，再进 handoff。
> 推荐先定两条最小约束：(a) mastery 数值旁必须有「来源/置信」可视标识（硬轨校准 vs prior-echo 至少二态可分）；(b) 节点详情页提供一个「诊断下钻」入口承载 CDM/IRT 画像。**待 owner 确认这两条作为 handoff 约束。**

---

## §2 形态/体验轨道（B 组）—— 转 claude design handoff + 补 Linear 工单
审计最尖锐的 implementation-actionability 发现：**整个形态轴 A1-A4 零 Linear 工单**，被双重 punt（「待 owner 拍 §7」+「交 claude design」）。8 条形态缺口建议建一个 **form-axis epic + 子工单**，每条带「现状反模式→目标 + 空态/失信兜底/故障态为显式功能约束」：

1. A1 交班缕「先轻后叙事」felt-experience（含**空夜态**——首日/连续无活动无昨夜可交班）。
2. 自主滑块「从 hint 滑到完整解」的功能形态（几阶/每阶给什么/逃生口/交还控制）—— **须先给功能规约再交视觉**。
3. D14 对话体验（回复长度/第一人称语气/何时叙事 vs 一句话+下钻）+ **主动开口时机**（练习卡住 nudge？录入后提议？）+ 对话面故障态（SSE 半截/工具失败/空回复）。
4. 四面跨 surface 体验连续性 + 24h 日节奏弧线（夜想→晨交班→日练→晚收尾）—— 须命名一份跨面 voice/引用契约。
5. **/knowledge 探索面整轴**（从没进形态轴）：双层异构图/误区节点/frontier 可供性/节点详情页承载 B1 三维+RT2 credit+RT1 误区/图大了的可读性退化（现 5000 行 OOM cap + 全量灌 MeshGraph）/ 已造好的 progressive disclosure 布局引擎（YUK-297）该不该接通。
6. 空态/冷启动/onboarding 端到端首次体验（空库→第一棵树→第一道题→第一次复习的最短闭环）。
7. **成效趋势面**（owner 提 rethink 的原始动机之一）：诊断答「现在会不会」（横截面），成效答「相比上次保持/迁移涨了吗」（纵向 delta）—— 开放题为主科目三量全退化，需替代进步可视化（哪怕 owner 自评趋势）。
8. 录入出口叙事（现 import 后硬 navigate 到死链 /mistakes）+ rescue 失败态 + phase0 已编目的边缘退化态（figure crop 无回显/PDF 超时不真取消/DOCX 绕过结构/空块）。

---

## §3 可延后（C 组）—— 我自驱，边做边定
A/B/C 完整 18 行归档表 · note_refine 的 `mastery_change` 触发器在新 mastery_state 下重接 + dwell 遥测去留 · 五段笔记 check 段落地形态 · 笔记挂载对齐双层图 + 笔记进度可见性 + 笔记 AI 改动撤销链并入 A/B/C · 全科扩科「新科目树从哪来」+ ASR/TTS 接 ingestion + 全科判分器跨科有效性 · D17「数据可丢」前提复审 + in-place 迁移机械 + 既有 active 题库冷启标定回填 · `actor_ref` 命名漂移（tencent_ocr 实跑 GLM）+ cost_ledger 对 mimo 恒记 0 · 零成本基线 gate 可见性 + dispatchAccept 下放 + capability 双轨收口 + 数值阈值实参（先埋点 N 周再定）。

> 跨科判分有效性（文科开放题全压一个 semantic judge，从没跨科核验）= C 组里最该升优先级的一条，直接关系认识论诚实锚——建议日用后首批验证。

---

## §4 本分支即办（不待批，对齐已决策）
1. **古文去主角化**：`2026-06-14-product-rethink-phase2-synthesis.md` §1/E1 仍拿「古文/古文开放题」当开放题天花板主例 → 改「跨科开放/主观题型」泛化（per 既定偏好）。
2. **bi-temporal doc 漂移对齐**（③H3）：`2026-06-13-memory-architecture.md` P4 bi-temporal 段加 superseded-by-ADR-0034 注。
3. **②d 反向断言**（备选，低风险）：archive.ts 补「每张业务 pgTable 必须在 FK_ORDER 或显式排除」断言 + 测试——防新承重墙表静默掉出备份。

---

## §5 下一步
owner 就 §1 的 **②（验收表）/ ③H10 / ④ / ⑤ / ⑥** 五处拍板（其余已确认/已办），之后：算法/结构骨架（Wave 0-2 承重墙）起跑实施，形态轴（§2）并行启 claude design handoff。本文经 owner 批后，把 §1 拍定项回填总账 §0/相关 ADR，§2 落 Linear form-axis epic。
