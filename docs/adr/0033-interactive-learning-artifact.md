# ADR-0033 — Interactive 学习 artifact：agent 生成的交互式学习内容（沙盒 HTML）

**Status**: Accepted（2026-06-09）— owner grill 逐条拍板。实现门禁：拍前不写 UI 代码（CLAUDE.md UI pre-flight）；落地走 impl issue。
**Part of**: YUK-203（领域模型重构，学习材料层）。与 note / question artifact 并列的**新学习材料类型**。
**Decision source**: 2026-06-09 copilot 呈现层 grill。起点是「copilot 怎么展示成品」，owner 校正：HTML artifact **不是数据视图，是 agent 生成的交互式学习内容**（互动式元素周期表为典型例），参考 Claude Artifacts。
**Related**: `docs/design/2026-06-09-copilot-presentation-layer.md`（呈现层；本类型是其 6 载体之一，copilot 是其作者之一）· ADR-0029（artifact 唯一容器 / tool_quiz 非块树先例）· ADR-0027（note artifact 解耦）· ADR-0032（`author_artifact` 写工具族）· Claude Artifacts（UX 参照）。

---

## 背景

呈现层讨论中浮现：copilot 要能产出**比静态卡片更丰富的学习内容**——互动式元素周期表、物理模拟、几何可视化、可排序的动词变位表等。这类内容：

- **是教具/参考材料**，不是用户数据的视图；多数**不绑用户数据、不联网、自包含**。
- **需要交互（JS）**——周期表要能点/筛/悬停。
- **持久、可复用、可按主题发现**——学化学时该能挂出那个周期表。

参照 **Claude Artifacts**：持久、命名、版本化、沙盒 iframe 渲染、专用面板、自包含可跑。本 ADR 把它确立为一种**新学习材料类型**（与 note/question artifact 并列），copilot 是其作者之一。

---

## 决定

### D1 · 类型
新 `ArtifactType='interactive'`（**语义 kind**，format=html；现枚举 `note_hub/note_atomic/note_long/tool_quiz` 之外新增）。**自包含、opaque、不进 note 块树 mesh**——复用 `tool_quiz` 先例（`body_blocks` null，载荷另置）。

### D2 · 存储
artifact 表行：`type='interactive'`、`body_blocks` null、HTML 源入 `attrs.html`（或新列）。复用 `version`+`history` 做**跨轮迭代**（v1→v2，作者改它）。tag `knowledge_ids` → **按主题可发现/复用**（化学节点 ↔ 周期表）。

### D3 · 谱系：reference，不是 practice
是**参考学习材料**（像 note），**不进 FSRS / 不是被调度的练习项**——它是教具不是题。未来可嵌 check（像 note 嵌 embedded-check），本期不做。

### D4 · 渲染 / 安全（核心）
**沙盒 iframe**：`srcdoc` + `sandbox="allow-scripts"`、**去 `allow-same-origin`**（null origin，碰不到父 DOM/cookie/localStorage）+ **CSP 完全禁网**（自包含内容无需外联）。
- **安全 greenfield**：全仓零 iframe/sandbox（仅 `LoomIcon` 的可信 SVG 用 `dangerouslySetInnerHTML`）——这层要新建。
- **威胁模型**：单用户自用工具，威胁不是恶意作者，是 **LLM 写错 / 被读到的内容 prompt-injection 后生成会外泄的 JS**。去 same-origin + 禁网 CSP 即足以兜住；不必上更重隔离（VM/微沙盒）。

### D5 · 渲染面
copilot 专用面板为主（复用 YUK-268 全屏抽屉）；但**比面板宽**——学某主题时可在知识节点页 / note 内嵌处挂出。chat 里 `primary_view:{source:'artifact', ref}` = 引用卡点开。

### D6 · 作者
copilot `author_artifact(type='interactive')` 按需生成 + `update_artifact`（version 升）跨轮迭代；`effect='write'`（单用户、路由守 scope）。**未来**可加生成 Task（像 quiz_gen 产题那样产交互式教具），留口本期不做。属 ADR-0032 `author_artifact` 写工具族的一个 type 分支。

### D7 · 与呈现层关系
是呈现层 6 载体中的「**持久交互式产物**」。copilot 是作者之一；呈现层文档引用本 ADR，不重复定义。

---

## 后果

- 新增 `ArtifactType='interactive'` 枚举值（Zod；artifact.type 是 text 列，无 DDL）。
- 新写工具 `author_artifact` / `update_artifact`（或 type-判别式的统一造 artifact 工具，与 ADR-0032 author 族对齐）。
- **新建沙盒 iframe 渲染层**（srcdoc + sandbox 去 same-origin + CSP 禁网）——安全 greenfield。
- 复用 artifact 表（`knowledge_ids` / `version` / `history` / `archived_at` 全现成）；HTML 源存储位（`attrs.html` vs 新列）impl 期定。
- 渲染面：copilot 面板 + 知识节点页 / note 嵌入（impl 期定优先级）。

## 不变量

- **自包含 + 沙盒 + 禁网**（D4）——agent 生成的 JS 永不触达父上下文/网络。
- **reference 非 practice**（D3）——不进 FSRS。
- **opaque 于 note 块树 mesh**（D1，tool_quiz 先例）——不参与 cross-link/embedded-check 写穿（除非未来显式加）。
- 破坏性 proposal-only 不适用（创建自包含内容非破坏性）；但仍全程 event 留痕可回滚（archived_at 软删）。

## Linear

开 impl issue（关 YUK-203 / ADR-0032 author 族 / YUK-268 全屏面板）；与 ADR-0031/0032 impl umbrella 并列。
