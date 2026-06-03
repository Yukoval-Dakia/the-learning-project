# Redraw Slice 3 — design pre-flight（knowledge list `/knowledge`：chrome + tree + proposals banner）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-knowledge.jsx`（checkpoint f85aca6d）。YUK-169 slice 3 / YUK-203 P5。
> **Base**: branch `yuk-169-redraw-slice3`（自 merge 后的 main，已含 slice-1+2：loom 基座/shell/primitives + LoomCard/LoomBadge + kd-detail 层）。

---

## 0. 范围（已与用户确认）

knowledge list 是最重 surface（1129 行：cytoscape 图 + tree + proposals + NodeDrawer + edge 交互）。**拆刀**：

- **本刀 slice-3** = page-head chrome（eyebrow/标题/树·Graph seg/CTA/lead）+ AI 关系提议 banner + **tree view**（know-node 行）+ Stateful 空/错/载态。
- **slice-3b（后续）** = NodeDrawer + 边提议 accept/reverse/change-type/dismiss + 建边表单 + graph 深度 loom 化。
- **graph 决策（已确认）**：**保留 cytoscape**（成熟库，fcose/拖拽/overlay，working；符合「OSS 解已解决问题不自建」），本刀只最小包装其容器，不替换为手搓 SVG mesh。

单文件 `app/(app)/knowledge/page.tsx` 里本刀只重绘 chrome+tree+banner+states；graph/drawer/edge-mutation **保持 working**（slice-3b 再绘）。文件暂时 loom+legacy 混用 = 增量拆分正常态。

## 1. 组件类型声明（CLAUDE.md 要求）

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive）** | `app/globals.css` 追加 KD-LIST 层：新 tree 类（`.know-node`/`.know-twig`/`.know-title`/`.know-end`/`.mastery-ring`+`.mastery-ring-t`，无冲突→全局）+ **scoped chrome 类**（`.knowledge-loom .seg`+`.seg button.on` / `.knowledge-loom .page-head`/`.eyebrow`/`.page-title`/`.page-lead`，**包在 `.knowledge-loom` wrapper 下**避免撞 legacy 同名）。 |
| **page（route）部分视觉重写** | `app/(app)/knowledge/page.tsx`：page-head + seg + CTA + lead + proposals banner + tree-view 块换 loom；graph/drawer/edge 逻辑不动。 |

> mastery 复用 slice-2 的 `Ring` primitive（不引第二种 ring 风格）。`.mastery-ring`/`-t` 仅在 Ring 不够用时才 port；优先 Ring。

## 2. 逐字引 loom（设计依据）

`screen-knowledge.jsx`（chrome+tree+banner 部分）：
- **page-head**：`.eyebrow`「KNOWLEDGE · {N} nodes · {M} edges (mesh)」`；`.page-head-row` → `.page-title.serif`「知识」+ `.hero-cta`（`.seg`（树/Graph，`button.on`）+ `<Btn variant="primary" icon="plus">`）；`.page-lead`「树是骨架（parent/child），mesh 是 5 类 typed 关系…」。
- **banner**：`<Card pad sunk borderColor:var(--coral-line)>` → `.card-icon.accent`（link）+「AI 提议了 {N} 条新关系」+ meta + `<Btn variant="secondary" size="sm" iconEnd="arrow" onClick={go("inbox")}>集中审批`。
- **tree row**：`<Stateful>` 包 `<Card>` 内 `.know-node`（`+.hot` when decaying）行：`know-twig └`（depth>0）+ `<MasteryRing pct size=30>` + `.know-title.wenyan` + `.chip.chip-k.mono`{tag} + decay `<Badge>` + `.know-end`（`{ev} ev` meta + `{n} 错` Badge + mesh `<Badge tone=info>` + `.thread-arrow`）；inline `paddingLeft: calc(--s-5 + depth*22px)`。空/载/错 = `Stateful`+`EmptyState`+`SkLines`。

## 3. 数据映射（基于 agent 实测；全部来自已有的 6 个 query，无新 endpoint）

| loom row 字段 | 来源 |
|---|---|
| MasteryRing pct | `KnowledgeNode.mastery`（0..1）×100；**保留 evidence-guard**：`evidence_count<3` → ring muted（不显误导绿），`=0` → 未练习态 |
| 标题 | `node.name` |
| tag chip | `node.id.slice(0,8)`（同 slice-2；无语义 tag 列） |
| evidence「ev」 | `node.evidence_count`（已在 snapshot，当前 tree 未渲染） |
| mistakes「错」 | 复用页面已建 `mistakeCounts` map（来自 `/api/mistakes?limit=200`，按 knowledge_ids fan-out） |
| mesh「link N」 | 复用已建 `edgeCountByNode` map（活跃边计数） |
| depth 缩进 / twig | `buildTree` 的 `node.depth`（已有） |
| banner count | 复用 `pendingEdgeProposals.length` |
| seg tree/graph | 复用 `view` state（保留 graph=cytoscape） |

## 4. 缺口 → 处理（不 mock）

| loom 字段 | 后端 | 处理 |
|---|---|---|
| decay Badge（稳定/缓降/衰减中） | list snapshot 无 FSRS/decay（仅 mastery/evidence/last_evidence/last_active）| **drop** decay Badge（同 slice-2；P3 FSRS 合入后再补。agent 提的 review-due-summary overdue 代理是语义拉伸，本刀不做） |
| `.hot` decaying 行高亮 | 无 decay 数据 | **drop** hot 样式 |
| CTA「新建节点」 | node-create 未接线 | loom 写「新建节点」但无 wiring；**保留当前 CTA 的真实行为**（toggle edge-create 表单，属 slice-3b 数据但 CTA 本身在 chrome）并 loom 化为 `Btn`，label 用真实功能「新建关系/取消」，不假写「新建节点」。或本刀先隐藏该 CTA 留 slice-3b——**默认：保留现有 edge-create toggle，loom 化按钮** |

## 5. CSS scope 策略（最高风险，agent 标记）

`.seg`/`.page-head`/`.page-head-row`/`.eyebrow`/`.page-title`/`.page-lead` 在 globals 已有 **legacy 同名定义**（~40 surface 依赖；slice-1/2 reconciliation 故意没 port loom 版）。**全局 port loom 版会回归这些 surface。**

→ **方案**：页面根 `<div className="page knowledge-loom">`；新 loom chrome 规则**全部 scope 在 `.knowledge-loom` 前缀下**（`.knowledge-loom .seg button.on{}`、`.knowledge-loom .page-head{}`、`.knowledge-loom .eyebrow{}`…）。新 tree 类（`.know-node`/`.know-twig`/`.know-title`/`.know-end`/`.mastery-ring`）grep=0 无冲突 → 可全局，但保险起见也放 `.knowledge-loom` 下。`.hero-cta`/`.card-icon.accent`/`.chip`/`.chip-k`/`.thread-arrow`/`.badge`/`Stateful 类` 已在 globals（slice-1/2）→ 复用不重定义。

## 6. Touch 文件清单

**MODIFY**：`app/globals.css`（追加 scoped `.knowledge-loom` chrome 层 + 全局新 tree 类，banner「LOOM KD-LIST LAYER — Slice 3」）· `app/(app)/knowledge/page.tsx`（page-head/seg/CTA/lead/banner/tree-view 块换 loom + 包 `.knowledge-loom` wrapper；**保留** selectedId/setSelectedId 接线、buildTree/mistakeCounts/edgeCountByNode/pendingEdgeProposals memo、graph/drawer/edge-mutation 全部不动）。
**REUSE（不动）**：`/api/knowledge`+edges+proposals+mistakes+review-due 查询 · `KnowledgeGraph`(cytoscape) · NodeDrawer + edge-create + edge-proposal mutation（slice-3b）· slice-1/2 primitives（Ring/Btn/LoomIcon/LoomCard/LoomBadge/Stateful/EmptyState/SkLines/SectionLabel）。
**KEEP-LEGACY（本刀仍引，slice-3b 退役）**：`MasteryBadge`（drawer）· `SuggestionKindTag`（EdgeProposalCard）· drawer/graph 内的 `Icon`/`Button`/`Card`。chrome+tree+banner 处去掉 `PageHeader`，chrome 的 `Button`→`Btn`、`Icon`→`LoomIcon`、banner `Card`→`LoomCard`、states→`Stateful`。

## 7. 风险 + 缓解

- **chrome class 冲突（最高）**：见 §5，全 scope 在 `.knowledge-loom` 下，append 前 grep 防全局重定义。
- **混用 legacy+loom 同文件**：本刀只换 chrome+tree+banner+states 块，graph/drawer 块原样；保留所有共享 state/memo 接线，确保 graph/drawer 仍 working（build 验所有路径）。
- **Ring evidence-guard**：tree row 紧凑，低 evidence ring muted（neutral），不显误导绿。
- **decay drop**：tree row 少一个 Badge，视觉略简——可接受（P3 FSRS 后补）。
- **build = CSS-layer + route-export 唯一 gate**（YUK-67）；额外验 tree↔graph 切换、节点选中开 drawer（仍 working）、banner→inbox。

## 8. Build order + verify gate

scoped CSS 层（globals）→ 重写 chrome/seg/CTA/lead/banner/tree-view（包 wrapper，复用 memo）→ **verify**：typecheck / lint / audit×3 / build（route+CSS）/ tree 列表渲染（mastery/ev/错/mesh/缩进）/ tree↔graph 切换 + 选中节点 drawer 仍开 / banner→/inbox。独立 review + push + PR（你 merge）。

---

*批准后按 build order 实施。本刀只重绘 knowledge list 的 chrome+tree+banner+states；graph 保留 cytoscape，NodeDrawer + 边交互 + graph 深度化留 slice-3b。*
