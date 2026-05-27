# Planning — Note artifact 重塑：block tree + Notion-like 编辑 + Living Note mutator-mode

**日期**：2026-05-26
**状态**：草稿（pending ADR-0020；post-grill 修订 supersede 原 §3-§6 三象限对比）
**来源**：YUK-85 Sub 3 (PR #154) smoke session 用户反馈 + 2026-05-26 CCG synthesis + grill-with-docs session
**对应 Linear**：[YUK-88](https://linear.app/yukoval-studios/issue/YUK-88)

---

## 0. Post-grill spec（2026-05-26，权威）

> 本节是经过 grill-with-docs 全量决策后的最终 spec。原 §1-§11 是早期 deliberation（B-path：增量引入 note_long），已被本节 supersede。保留 §1-§2 作为问题背景；§3-§11 仅作历史决策档案，不作为实施依据。

### 0.1 路径选择：Y（重写 atomic schema 为 block tree）

原计划是增量 B-path（atomic 不动，引入 note_long 第三态）。grill 后路径升级到 **Y（≈ 原 §3.C 复活但更精确）**：

- 三 type 保留：`note_hub` / `note_atomic` / `note_long`（**Q11.e**）
- 三 type **共用** `body_blocks JSONB` schema field（DROP 原 `sections[]` / `outline_json` / `child_artifact_ids[]`）
- 三 type 区分仅靠 **verifier 约束 + AI prompt + 渲染 idiom**，不靠物理 schema 字段
- 原 ADR-0019 section_id 稳定性 invariant **整体废止**，由本 phase 的 ADR-0020 接管为 "block_id 稳定性 + Notion 位置规则"

### 0.2 核心模型决策（grill 拍板的 Q1-Q19）

| 维度 | 决策 | 来源 |
|---|---|---|
| **block tree schema** | TipTap doc.toJSON() 形态（`{type, content[], attrs, marks[]}`），**不是** Codex 早期建议的 `{id, type, children, attrs}`（PM 模型胜出）；body_blocks JSONB 内 PM doc | Q19a |
| **atomic 形态** | block tree；`definition / mechanism / example / pitfall / check` 降级为 `block.attrs.semantic_kind` 标签；verifier 强制 5 semantic_kind 至少各出现 1 次 | Q5, Q6.b |
| **long 形态** | 自由 block tree；无 semantic_kind 约束；可挂 N 个 knowledge_ids | Q5, Q6.b |
| **hub 形态** | block tree；verifier 强制 ≥ 3 个 cross_link block；用户可编辑（加引言 / 排序 / 加 callout） | Q11.e |
| **knowledge 关系** | label 模型：`artifact.knowledge_ids text[]`（plural）；artifact 必须至少 1 个 knowledge_id（没有就走 propose_knowledge 路径） | Q7.5.b, Q8a |
| **atomic ↔ knowledge** | atomic 仍 1 节点简介；`knowledge_ids` 数组长度恰好 1（verifier 强制）；**不限节点位置**（叶子 / 中层都可）；旧版本 archive 不 hard delete | Q8b, Q9a |
| **atomic 内容来源** | AI prompt 看 **节点自身 + outgoing knowledge_edge**（不下钻子节点；目录职能由 hub 承担） | Q9b |
| **cross_link 在 atomic 内** | atomic 不显式写 cross_link；渲染时按 outgoing knowledge_edge 自动追加"相关概念"区 | Q9c |
| **链接物理形态** | L3+L2 索引混合：block 内 `attrs.cross_link = { artifact_id, block_id? }`（source of truth）+ `artifact_block_ref` 辅助索引表（write-through）做反链 O(log N)；`knowledge_edge` 留作概念关系，不混 note ref | Q7 |
| **mark-wrong 颗粒** | block 级 anchor（block_id）；UI 默认聚合到 `semantic_kind` / 最近 heading 级、可钻取到具体 block；现存 atomic section_id 历史 → migration 不考虑（无数据，仅 tests rework） | Q10.a, Q15 |
| **anchor 稳定性** | Notion 位置规则：split → 原 id 跟"上半"、下半新 id；merge → 前 block id 保留、后 block id 丢弃；**无 `supersedes` / `derived_from` 字段**；annotation 在丢弃 block 时丢失（accepted tradeoff，跟 Notion 一致） | Q2 revised, Q14.e |
| **embedded check** | 独立 `tool_quiz` artifact + 在 atomic body_blocks 内 `{ type: 'artifact_ref', target: { artifact_id, kind: 'tool_quiz' } }` 引用；inline render；quiz 与 atomic 无 parent-child；删除 atomic 不 cascade 删 quiz | Q13.d |
| **lineage / supersedes** | 无；事件层（ADR-0006 v2）的 event log 是 superset，agent 也通过 events 而非 block lineage 推理因果 | Q14.e |
| **LearningIntent 产出契约** | 1 hub + N atomic + 0-M long（AI 可选输出综合 long）；atomic 不再强制叶子，AI 优先叶子但可 justify 中层；propose_knowledge + propose_artifact 一次 accept；NoteGenerateTask 单 task 内部 `type` 参数 switch（atomic / long / hub 共用 handler 框架）| Q12.a2 / Q12.b2 / Q12.c1 / Q12.d2 |
| **Living Note v0 范围** | day1 ship 全套（atomic + long + hub），**mutator-mode 直接落库**；不走 propose-then-accept 路径 | Q16.c |
| **Living Note 分级** | 小 patch（`insert_after` / `replace_block` 等 block 级 op）走 mutator-mode；激进 mutation（整 artifact 重写 / 自动跨主题生成 long）走 propose-then-accept | Q18.1.b |
| **并发协调** | AI Idle-detection 排队：客户端 presence heartbeat；server 写入前查 editing_session，idle 时 flush AI patch；editing 中 deferred；超时（如 10min）强行 apply | Q17.b |
| **Undo 模型** | Living Note 每次 apply 落 event；用户 always 可 undo（per-block + 集中 view 批量）| Q17.1.a |
| **AI mutation 集中入口** | 双入口：`/today` 加 "Living Note 活动卡"（24h digest + 批量 undo）+ artifact 页内 "AI 改动" tab（本 note timeline） | Q18.d |
| **note 编辑器** | TipTap（ProseMirror wrapper），React-first，headless（UI/UX 100% 你的）；body_blocks = PM doc.toJSON() 形态；阅读视图独立 `<BlockTreeRenderer>` SSR-only 共享 NodeView 组件、不加载 editor bundle | Q19a.b |
| **day1 编辑范围** | 完整 Notion-like：text edit / split / merge / drag-drop / paste markdown / undo-redo / inline marks / slash command / block cross_link / mention 输入 | Q19b |
| **hub auto-sync** | 双区：手动区在前 + 自动区在后；自动区是 `AutoLinksContainer` block group（用户可重排顺序、不可增删 children）；nightly worker 维护；用户可 dismiss（落 `artifact.attrs.suppressed_block_refs[]`，下次跳过）；自动区每条带"系统维护 / via prerequisite / via 派生 / via 对比 / via 子主题" relation chip | C1.b / C1.1.b / C1.3.a-ii+b-ii+c-i+d-ii |
| **hub 包含判定** | iii-curated：`atomic.knowledge_ids ⊆ hub.knowledge_ids`（全包含，C1.2.b）+ tree descendant + mesh 关系（`prerequisite` incoming / `derived_from` outgoing / `contrasts_with` symmetric）；**不包含** `related_to` / `applied_in` / `experimental:*`（后两个 future per-hub opt-in） | C1.4.iii-curated |
| **knowledge node 节点页** | `/knowledge/[id]` 分层视图：节点元数据 + mastery + mesh 邻居 chip → 主 atomic body_blocks inline 渲染 → "出现在" 反链 panel（hub / long 分组） → 最近活动 timeline；无主 atomic 时占位卡 + 一键生成；与 hub 职责分离（节点页 = 视图，hub = 作品）；day1 不做 D graph 视图、roadmap phase 2+ 启用 | C2.B / C2.1.a / C2.2.i |
| **archive / version 模型** | **不做 v1 → v2 整篇重写**；所有 mutation 都是 block 级增量 patch（用户 / AI / Living Note 共用）；docs/modules/notes.md §5 "重写整 atomic" 信号 → 改为"propose 多条 patch"；用户主动 "regenerate" 按钮触发 propose 多 patch（不 wipe）；`artifact.archived_at` 字段保留作 future auto-archive maintenance agent 槽位、day1 不做 UI | C3.d / C3.1.a / C3.2.b |
| **P1 ADR 范围分担** | ADR-0020 定核心契约（anchor / cross_link / semantic_kind / archive / version 模型）；具体 TipTap PM node schema 在 P2 跑通后补 ADR-0022；P2 实现期间 schema 微调允许（每次更新 ADR） | C4.2.c |

### 0.3 schema 变更（DDL 层）

```sql
-- 三态共用 body_blocks，DROP 三个老字段（无数据，安全 DROP）
ALTER TABLE artifact DROP COLUMN sections;
ALTER TABLE artifact DROP COLUMN outline_json;
ALTER TABLE artifact DROP COLUMN child_artifact_ids;
ALTER TABLE artifact ADD COLUMN body_blocks JSONB;

-- knowledge_id → knowledge_ids plural（label 模型）
ALTER TABLE artifact DROP COLUMN knowledge_id;
ALTER TABLE artifact ADD COLUMN knowledge_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- artifact.attrs JSONB（含 suppressed_block_refs[] 等扩展槽位；hub auto-sync dismiss 落点）
-- 若 artifact 表已有 attrs 槽位则复用；否则：
ALTER TABLE artifact ADD COLUMN attrs JSONB NOT NULL DEFAULT '{}'::jsonb;

-- L2 cross_link 辅助索引表
CREATE TABLE artifact_block_ref (
  from_artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  from_block_id TEXT NOT NULL,           -- TipTap node id（自定义 attrs.id 槽位）
  to_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  to_block_id TEXT,                       -- 可空：指向 artifact 整体
  PRIMARY KEY (from_artifact_id, from_block_id, to_artifact_id, COALESCE(to_block_id, ''))
);
CREATE INDEX artifact_block_ref_to_idx ON artifact_block_ref (to_artifact_id, to_block_id);

-- event.referenced_knowledge_ids GIN index（节点页 timeline 性能预案）
CREATE INDEX event_referenced_knowledge_gin
  ON event USING GIN ((payload -> 'referenced_knowledge_ids'));

-- correction event payload：section_id → block_id（schema rewrite，无数据 backfill 任务）
-- 见 src/core/schema/event/known.ts line 234-242，需把 section_id?: string 改为 block_id?: string
```

### 0.4 ADR 变更

- **ADR-0019 整体废止** → ADR-0020 接管
- **ADR-0020（新，核心契约）**：本 phase 的核心架构契约（C4.2.c）
  - block_id 稳定性 + Notion 位置规则（split / merge）
  - **无 lineage 字段**（明确选择，理由见 Q14.e 讨论）
  - L3+L2 cross_link 索引混合
  - artifact / knowledge label 关系
  - atomic vs long vs hub 三态共用 body_blocks + 仅靠 verifier 约束区分
  - archive / version 模型：**不做 v1 → v2 整篇重写**，所有 mutation 都是 block 级增量 patch
  - hub auto-sync 双区机制 + iii-curated mesh 包含判定
- **ADR-0022（新，PM node schema）**：TipTap PM doc 具体 node 形态（P2 跑通后补）
  - SemanticBlock / CrossLinkBlock / ArtifactRefBlock / CalloutBlock / AutoLinksContainer 等自定义 node 的 attrs / content / marks 规约
  - paste / drag-drop / undo 在 PM 模型下的具体语义
  - P2 实现期间允许微调，每次更新 ADR
- **ADR-0006 v2 不动**：events 仍是真相；本 phase 只是 event payload section_id → block_id rewrite
- **ADR-0010（knowledge mesh）不动**：knowledge_edge 留作概念关系，cross_link 不污染；本 phase 引用 mesh edge 做 hub auto-sync 判定（iii-curated）
- **ADR-0012（mastery derived）不动**：mastery 仍从 question events 派生，artifact knowledge_ids 是 label 不入 mastery 投影

### 0.5 阶段拆分（成本重估，含 C1-C3 增量）

> 原 plan 16pts → 实际 ~61pts，~17-20 周（编辑器 + Living Note + hub auto-sync + knowledge node 节点页 + tests rework + LearningIntent rework）

| Phase | 内容（含 C1-C3 增量） | 估算 |
|---|---|---|
| **P0 — Spike（2 pts）** | TipTap 接入 fixture 验证：手写 PM doc fixture → 渲染 → 编辑 split/merge → mark_wrong 命中 block → idle apply mock AI patch | 0.5 周 |
| **P1 — Schema + ADR-0020 核心契约（5 pts）** | DDL（DROP sections/outline/child_artifact_ids，ADD body_blocks/knowledge_ids，建 artifact_block_ref 表，artifact.attrs.suppressed_block_refs[]）+ correction event payload 改 + ADR-0019 废止 + ADR-0020 写 + audit:schema allowlist | 1 周 |
| **P2 — TipTap 编辑器接入（16 pts）** | TipTap 集成 + 自定义 nodes（SemanticBlock / CrossLinkBlock / ArtifactRefBlock / CalloutBlock / **AutoLinksContainer**）+ slash command + inline mention + drag-drop + paste markdown + undo/redo + `<BlockTreeRenderer>` SSR mode + bundle 拆分 + 跑通后补 ADR-0022 | 5-6 周 |
| **P3 — AI pipeline 重写（10 pts）** | NoteGenerateTask 单 task + type switch；prompt 三套（atomic 含 5-semantic_kind / long / hub 含 cross_link 编织）；NoteVerifyTask 改为 verifier 约束；LearningIntent 改产 1 hub + N atomic + 0-M long；propose_knowledge + propose_artifact 一次 accept | 3-4 周 |
| **P4 — Living Note v0（10 pts）** | NoteRefineTask（mark_wrong / mastery / 错误率 triggers）；mutator-mode patch op apply；idle-detection 协调（client presence + server worker）；undo event projection；`/today` 活动卡 + artifact 页 "AI 改动" tab；分级（小 patch mutator / 激进 propose）；用户主动 regenerate 按钮路由到 propose 多 patch（C3.1.a） | 3-4 周 |
| **P5 — 反链 + cross_link UI + hub auto-sync（8 pts，+3 from C1）** | block-level cross_link mention 选择器；block 反链 panel（查 `artifact_block_ref`）；**nightly hub auto-zone 更新 worker（iii-curated mesh query：tree descendant + prerequisite incoming + derived_from outgoing + contrasts_with symmetric）**；**`AutoLinksContainer` 内 dismiss 操作 + event**；**各 relation 类型 chip（系统维护 / via prerequisite / via 派生 / via 对比 / via 子主题）** | 2-2.5 周 |
| **P6 — YUK-89 read-view + 节点页（6 pts，+3 from C2）** | `<BlockTreeRenderer>` 按 semantic_kind 渲染 idiom + hover 低对比稳态 + Lucide AlertTriangle + mark-wrong 钻取；**`/knowledge/[id]` 分层视图（节点元数据 + mesh 邻居 + 主 atomic inline + "出现在" 反链 panel + 最近活动 timeline）**；**无主 atomic 时占位卡 + 一键生成（C2.1.a）** | 2 周 |
| **P7 — tests rework（4 pts，+1 from C1/C2/C3）** | learning_intent.test / ArtifactSections.test / note_generate.test / correction event projection test 等全部按新 schema 重写；**+ nightly hub auto-sync worker test**；**+ 节点页 SSR test**；**+ regenerate-as-propose 路径 test** | 1 周 |

**Total**：~61 pts，~17-20 周 elapsed（单人）。

**Phase 依赖图**：

```
P0 → P1 → ┬→ P2 (编辑器) ──────────────────→ ┬→ P5 → P6 → P7
          └→ P3 (AI pipeline) → P4 (Living) ──┘
```

**实施策略（C4.1.c）**：不预设 "day1 MVP vs full" 拆分；按 phase 滚动落 PR，每个 PR 进 staging 即时验。中途允许调整 priority，但不背"day1"硬时间承诺。

**风险评估**：

| 风险 | 缓解 |
|---|---|
| **P2 编辑器 16pt 是估算上限** | TipTap 接入复杂度未亲手验过；P0 spike 跑通 fixture 后 P2 估算应该收敛到 ±15% 内 |
| **P3 + P4 并行可能撞 schema** | P1 ADR-0020 钉死核心契约；P2 跑通后补 ADR-0022 锁 PM node schema；P3/P4 在 ADR-0022 后才可并行 |
| **P5 mesh-curated query 性能** | iii-curated 是一次 `JOIN knowledge_edge ON ... WHERE relation_type IN (...)`；当前数据规模（单用户，估 < 1000 knowledge nodes）无问题；超 10k 节点时加 partial index `(relation_type, from_knowledge_id)` |
| **P6 节点页 events timeline 性能** | event log 按 `referenced_knowledge_ids @> [k_id]` 过滤；现 schema 是 JSONB，需 GIN index `CREATE INDEX event_referenced_knowledge_gin ON event USING GIN (referenced_knowledge_ids)`；纳入 P1 DDL |

### 0.6 Open

C1-C4 已在 grill 第二轮拍板（见 §0.2 决策矩阵 hub auto-sync / 节点页 / archive 模型 / 成本与 ADR 分担行）。仍 Open：

- **Living Note trigger signals 具体映射**：mark_wrong / mastery / dwell / 错误率 各触发什么 op，propose vs mutator 分级粒度 —— spec 在 P4 实施时定，参考 docs/modules/notes.md §5 老 list
- **per-hub opt-in `applied_in` / `related_to` mesh 扩展**：day1 不做，phase 2 用户配置项启用
- **D graph 视图**（C2 的 phase 2+ roadmap）：节点页升级为图谱视图（节点为中心 + 邻居 + 相关 artifact 浮在节点旁）；实施时机看实际使用反馈
- **dismiss 后的 chip 显示**：被 dismiss 的 atomic 是否在 hub 自动区显示一个"已隐藏，恢复"的小占位？还是完全不显示？UX 细节，P5 实施时拍
- **mesh edge weight 是否参与 hub auto-zone 排序**：当前 `knowledge_edge.weight: real`（0-1）是 AI confidence；P5 实施时决定是否按 weight 排序展示
- **AI prompt 复杂度收敛**：P3/P4 实施期 prompt token 预算估算，可能需要分 sub-prompt 调优 —— 不进 ADR
- **dreaming agent 自动归档闲置 artifact**（C3.2.b future）：实施时机看 maintenance agent 整体优先级

### 0.7 与既有 superpowers / planning docs 的衔接

- 本 phase 与 YUK-87 Living Note 合并实施（Q16.c 后 YUK-87 v0 = 本 phase P4）
- 与 YUK-89 atomic 阅读页 redesign 合并实施（Q19 后 redesign 落在 P6 + P2 共享 NodeView 组件）
- YUK-85（mark-wrong section 颗粒）的 section_id 契约整体被本 phase 推翻，section_id correction event payload 改为 block_id；YUK-85 PR #154 ship 的 mark-wrong UX 行为契约仍 hold（只是 anchor 颗粒变细）

---

## 1. 问题陈述

当前 Note artifact schema (`docs/architecture.md:421-437`、`docs/modules/notes.md §2-§3`) 只有两态：

- `note_hub`：大纲（`outline_json` + `child_artifact_ids[]`），**不持正文**
- `note_atomic`：5-section 结构化笔记（`definition` / `mechanism` / `example` / `pitfall` / `check`），**1:1 挂 knowledge 叶子**

对中大型主题（如「氧化还原反应」），当前拆法 → 1 hub + ~6 atomic、每 atomic 5 section、每 section 一两句话 → **单页信息量稀薄、跨页阅读割裂、概念间的内在 link 全靠用户脑补**。

用户原话（2026-05-26）：

> 对于末端节点，atomic 这么做确实是好的。但比如氧化还原反应这个大类，可读性很差，信息量太少。大部分中大型知识点都适合参考 Notion 这些笔记软件，允许挂 label / 有 link / 有层级。

## 2. 已下注的链路（不能轻易丢）

- **YUK-87 Living Note**：`NoteRefineTask` 触发器 6 (user mark_wrong) 直读 `getArtifactCorrectionState` —— 依赖 section 颗粒度
- **YUK-85 PR #154 mark_wrong**：section_id 是稳定 anchor，是 correction event 投影的 join key
- **Embedded check**：1-3 题嵌在 atomic note 的 `check` section（`docs/modules/notes.md §6`）
- **Mastery 投影**：在知识叶子层累积；atomic ↔ 叶子 1:1 是计算前提
- **ADR-0019**：section_id 稳定性 invariant
- **ADR-0006 v2**：artifact 表设计、AI 产出落点

## 3. 三象限对比

### A. atomic 内 section 富文本嵌段（不新增 type）

保留 5-section 骨架，但每个 section 内允许 toggle / callout / nested list / link-to-other-artifact / inline math / code 嵌段。

| 收益 | 代价 |
|---|---|
| 增量改动最小 | 不解决"大主题需要一页流"的诉求 |
| 不破 mark-wrong / mastery / living note | section 颗粒不变 → "中大型主题"还是要拆 ~6 atomic |
| AI pipeline 几乎不动 | 5-section 模板对中大型主题仍是镣铐 |

**结论**：必要但不充分。可作为 B 的预备步（让 atomic 本身更厚）。

### B. 引入第三态 `note_long`（**推荐**）

三态并存：

```
note_hub      ─→ 大纲（不持正文）
note_atomic   ─→ 5-section 结构化（叶子）
note_long     ─→ Notion 式自由 doc（中层节点 / 大主题）
```

`note_long` 特性：
- **挂载粒度**：可挂中层 knowledge 节点（不强制叶子）
- **内容形态**：rich block tree（`body_blocks JSONB`），支持 heading / paragraph / list / callout / toggle / quote / code / math / image / artifact_ref / cross_link
- **生成路径**：新 `NoteLongGenerateTask` —— 独立 prompt，不共享 NoteGenerateTask 的 5-section schema 约束
- **mark_wrong 颗粒**：扩展为 block_id（ADR-0019 后续 ADR-0020 落契约）
- **Living Note**：YUK-87 `NoteRefineTask` 兼容 long block 颗粒（v0 可只对 atomic 生效）

| 收益 | 代价 |
|---|---|
| 增量、可逐步 land | schema + AI pipeline + 阅读视图三套独立流 |
| 不破现有 atomic / mark-wrong / mastery / embedded check 链路 | ADR-0020 + ADR-0019 扩展（mark-wrong block-id 颗粒） |
| YUK-87 Living Note 可分期支持 | 两类 note 的 verification / refine prompt 各写一套（共享 profile / rubric / schema validator 收敛维护成本） |
| 用户对中大型主题立即有"Notion-like 一页流"体验 | 阅读组件不复用是设计选择，不是陷阱（语义不同 → idiom 不同）；但 Badge / anchor / 验证状态共享 |

> **关键陷阱**：mark-wrong 颗粒分裂（section vs block）。**必须** 在 P1 抽统一 `ArtifactAnchor(section\|block)` + projection API，否则 Living Note / mark-wrong / correction event 投影会沿 atomic / long 分叉。anchor 契约是 B 方案的承重墙，不是 P4 收尾活。

### C. 重写整层 —— 统一一种 `note` + section anchor

取消 hub / atomic 区分，所有 note 都是自由 doc；mastery / mark_wrong 改挂 anchor。

| 收益 | 代价 |
|---|---|
| 最像 Notion / 最自由 | 推翻 ADR-0006 v2 + ADR-0019 + LearningIntent orchestrator + NoteGenerate-Verify + Living Note 全链路 |
| schema 最简 | 月级工程；推翻已 ship 的 4+ ADR |
| Mastery / embedded check 全部重设投影 |

**结论**：成本不可承受。否决。

## 4. 推荐方向：B

理由：
- **增量**：不破 ship 中的 mark-wrong / mastery / embedded check
- **可逐步**：P1 ADR + schema → P2 AI pipeline → P3 阅读视图 → P4 mark-wrong + living note 兼容
- **兼容 YUK-87**：Living Note v0 可只对 atomic 生效，long 后跟进
- **用户立即受益**：中大型主题的"Notion-like 一页流"在 P3 就可见

## 5. 阶段拆分

### P0 — Spike（~1 pt，先于 P1）

CCG synthesis 结论：anchor 契约 + block_id 稳定性是 B 的承重墙，纸面拍板不够。先跑一个 fixture-only spike 验证：

- 手写一份 fixture `note_long` JSON（自定义 block schema 草案：`{id, type, children, attrs}`）
- 跑通：渲染 → mark_wrong 命中 block → `NoteRefineTask` mock 改写 block 后 block_id 仍稳
- 验证 split / merge 场景：编辑后产生新 block 时，`derived_from / supersedes` 字段够不够投影 mark-wrong / Living Note 复用
- 输出：ADR-0020 草稿 + anchor projection API 接口签名

P0 不写 production 代码，目的是把 P1 ADR 的开放问题降到零。

### P1 — ADR + Schema + Anchor 契约（~5 pts）

- ADR-0020：`note_long` 第三态契约
  - schema 字段（`type='note_long'`、`body_blocks JSONB`、自定义 block JSON `{id, type, children, attrs}`）
  - 挂载约束（可挂中层节点 / 不强制叶子 / 与 hub-atomic 互斥）
  - **anchor 契约**（**承重墙、不可拖延到 P4**）：
    - 统一抽象 `ArtifactAnchor`，atomic 用 `section_id`、long 用 `block_id`
    - **anchor id 稳定性**：编辑 / 重排保 id；split / merge 给新 id 并记 `derived_from / supersedes`
    - ADR-0019 续作 ADR-0020 §X "anchor id 稳定性" —— 不是新规，是 invariant 的扩展
  - **projection API 入口**：`getArtifactCorrectionState(artifact_id)` 在 ADR-0020 阶段就要支持 anchor union，atomic / long 共用一个调用
- Drizzle migration：`artifact` 表加 `body_blocks JSONB nullable`；correction event subject scope 加 `block` 枚举
- `audit:schema` allowlist 处理（body_blocks 暂无 write path）

### P2 — AI Pipeline（~5 pts）

- `NoteLongGenerateTask` 注册 + handler
- `NoteLongVerifyTask` 注册 + handler
- `LearningIntent` orchestrator 路由：按知识节点层级 / outline hint 决定 atomic vs long
  - 中层节点 → `note_long`
  - 叶子节点 → `note_atomic`
- pg-boss `note_long_generate` queue + worker

### P3 — 阅读视图（~5 pts）

- `<NoteLongRenderer>` 独立 component（不复用 ArtifactSections）
- block-tree 渲染器（heading / paragraph / list / callout / toggle / quote / code / math / image / artifact_ref / cross_link）
- 嵌 atomic block_ref → 内联展开 / link-jump 二选一
- 跨知识点 cross_link → 解析为 knowledge_id / artifact_id

### P4 — mark-wrong + Living Note 接线（~2 pts）

> anchor 契约已在 P1 落地，P4 只是把 long doc 接上既有 anchor projection API。

- POST `/api/artifacts/[id]/correct` 通过 P1 anchor union 已支持 `block_id`，仅补 long 专属校验
- UI：long doc 内 block hover → 标错入口（复用 atomic mark-wrong UX 思路）
- Living Note (YUK-87) `NoteRefineTask` v0 仍只读 atomic；long 颗粒留 future（anchor 已就位，future 启用零迁移成本）

**Total**：~18 pts（P0 1 + P1 5 + P2 5 + P3 5 + P4 2）；P0 是 spike PR，P1-P4 chain-merge

## 6. 待决问题（CCG 已拍板的标 ✅，剩余留 P1 ADR）

1. **block tree schema** ✅ → **自定义 JSON** `{id, type, children, attrs}`
   - 理由：轻、AI 生成 + 服务端校验、稳定 id 控制权完全在我们手里
   - **Tipping point**：要做协同编辑 / 复杂 marks / paste-import / selection 时再上 TipTap / ProseMirror，不是现在
2. **note_long 是否支持 inline 编辑**？
   - v0 read-only（AI 写）就够；编辑器留 future
3. **note_long 与 note_hub.outline_json 的关系** ✅ → **选项 c：完全独立**
   - hub 留作索引 / 路径，不持正文（不要把正文塞 outline_json）
   - long 独立 artifact，可挂中层；atomic 继续叶子 1:1 撑 mastery
   - 三者职责清晰：hub = 导航、atomic = 叶子知识 + mastery 锚点、long = 中层叙述
4. **embedded check 是否可挂在 note_long**？
   - v0 不挂；check 仍是 atomic 专属
   - future：long 内 callout-style check block
5. **跨 artifact link 的语义**：
   - cross_link 是否会触发 mastery 联动？
   - 是否走 knowledge graph 边？

## 7. 风险

| 风险 | 缓解 |
|---|---|
| AI pipeline 两套 prompt 维护成本 | 共享 system prompt 骨架；differ 部分在 user prompt 模板 |
| 用户混淆 atomic / long 边界 | 不暴露 type 给用户；按知识节点层级自动路由 |
| long doc 太自由，AI 输出失控 | NoteLongVerifyTask 做结构 + 覆盖度 check（同 NoteVerifyTask 路径） |
| YUK-87 Living Note 推迟 long 支持 | v0 文档显式声明：long 不参与 Living Note v0 |

## 8. 相关 docs

- `docs/architecture.md` § Artifact 多态化
- `docs/modules/notes.md` § 1-§7
- ADR-0006 v2（artifact 表）
- ADR-0019（section_id 稳定性）
- ADR-0020（待写：note_long 契约）
- YUK-85（mark-wrong section 颗粒）
- YUK-87（Living Note）

## 9. Open

- 是否要先做 A（atomic section 嵌段）作为 B 的预备步？倾向不做 —— P0 spike 验证 long 后直接 B
- LearningIntent orchestrator 的 atomic vs long 路由信号：层级硬规则 vs AI 软判断？P2 决策
- split / merge 场景的 `derived_from / supersedes` 字段够不够 Living Note 投影复用 —— P0 spike 验证

## 10. CCG synthesis 备注（2026-05-26）

本文档已根据 CCG（Codex + Gemini 双 advisor）建议修订：

- §4 增加 anchor 分裂陷阱预警 + 阅读组件不复用是设计选择的澄清
- §5 P0 spike 前置；P1 ADR-0020 扩到 anchor 契约 + projection API；P4 缩为接线
- §6.1 block schema 拍板自定义 JSON + tipping point；§6.3 hub 关系锁定独立

Codex artifact: `.omc/artifacts/ask/codex-ai-note-artifact-…-2026-05-26T12-30-05-411Z.md`
