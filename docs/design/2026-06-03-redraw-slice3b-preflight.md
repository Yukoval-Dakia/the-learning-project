# Redraw Slice 3b — design pre-flight（knowledge NodeDrawer + 提议交互）

> **Status**: Pre-flight, awaiting user approval（CLAUDE.md UI 规则）。
> **Source**: loom-prototype `screen-knowledge.jsx`（NodeDrawer/EdgeProposalRow，checkpoint f85aca6d）。YUK-169 slice 3b / YUK-203 P5。
> **Base**: branch `yuk-169-redraw-slice3b`（自 origin/main 4f5d295a，含 slice-1/2/3）。

---

## 0. 范围（研究 agent 建议拆分，已采纳）

knowledge-list 的 deferred 部分再拆：

- **本刀 slice-3b** = NodeDrawer（`detail-drawer`）整段 loom 化 + 边提议 accept/reverse/change-type/dismiss + 节点提议 accept/reject + 近活动段。
- **slice-3c（后续）** = EdgeCreateForm（带「页级 3-select+reasoning vs loom 抽屉内 chip+dir-toggle」未决设计选择）+ cytoscape graph 周边（KG 几乎 no-op，cytoscape 保留）。

拆因：drawer 是干净机械 port（CSS 依赖大多已 port，低风险）；edge-create 带设计判断不该阻塞 drawer。点节点弹出的抽屉是当前「loom 页 + legacy 抽屉」视觉不一致的主因 → 本刀消掉它。

## 1. 组件类型声明

| 类型 | 物 |
|---|---|
| **设计基座（CSS，additive）** | `app/globals.css` 追加少量新类：`.drawer-sec-h`（loom mono 段头）· `.node-metrics`/`.nm`/`.nm-n`/`.nm-l` · `.edge-prop`/`.edge-prop-head`/`.edge-prop-acts`/`.resolved`（来自 screens-2b.css L71-83）。其余（`.drawer`/`.scrim`/`.drawer-sec`/`.rel-row`/`.rel-tag-*`/`.quiet-empty`）已在 globals（slice-1 shell + slice-2）→ 复用。 |
| **page（route）部分视觉重写** | `app/(app)/knowledge/page.tsx` 的 `<aside className="detail-drawer">` 段（L649-809）就地重写为 loom `.drawer`/`.scrim` + `useFocusTrap` + `role="dialog"`；`EdgeProposalCard`（L1116-1209）→ `.edge-prop`；节点提议行 + `ActorPill`/`KnowledgeRelation` helper 换 loom。**不抽独立组件**（省 ~10 prop 线程，降重构风险）。 |

## 2. 逐字引 loom（NodeDrawer L157-234 / EdgeProposalRow L236-256）

- `.scrim`（点击关闭）+ `<aside className="drawer open" role="dialog" aria-modal aria-label aria-hidden>`，`useFocusTrap(open,onClose,panelRef)`。
- **drawer-head**：`<NodeRing pct size=40>` + `.drawer-title.serif` + `.meta.mono {tag · kind}` + `<IconBtn icon="close">`。
- **drawer-body**：`.node-metrics`（3×`.nm`：`.nm-n.serif` 数 + `.nm-l.meta` 标）· 层级 `.drawer-sec`+`.drawer-sec-h`（`<Icon tree>层级`，parent/children `.rel-row`（child 带小 NodeRing））· 关系 `.drawer-sec`（typed edges `.rel-row`+`.rel-tag-{rel}`）· AI 提议的边 `.drawer-sec`（`EdgeProposalRow`）。
- **EdgeProposalRow**：`.edge-prop` / `.edge-prop-head`（`.rel-tag-{rel}` + 方向 wenyan + `{confidence%}`）/ `.edge-prop-acts`（4×`<Btn size=sm>`：接受 good/check · 反向 ghost/reverse · 改类型 ghost/refresh · 忽略 ghost/close）；resolved → `.edge-prop.resolved` + `.badge.tone-good`。
- **drawer-foot**：`<Btn variant=primary block iconEnd=arrow>打开节点详情页` → `go("knowledge/"+id)`。

## 3. 数据映射（研究 agent 实测：mutation/选择数据全已接线）

| loom 字段 | 来源 |
|---|---|
| head 标题 | `selected.name` |
| head NodeRing | `NodeRing`（wraps `Ring` primitive；`selected.mastery`×100，复用 slice-3 pattern + evidence-guard：<3 muted/0 未练习） |
| node-metrics 掌握度 | `selected.mastery` |
| node-metrics evidence | `selected.evidence_count` |
| 层级 parent/children | `selected.parent_id`+`byId` / `childrenByParent.get(id)`（child 行加小 NodeRing） |
| 关系 typed edges | `selectedEdges`（按 `RELATION_ORDER` 分组，`.rel-tag-{relation_type}`，重写 `KnowledgeRelation`） |
| 边提议 4 action | `selectedPendingEdges` + `edgeProposalDecision.mutate({id,decision,new_relation_type})` + 乐观 `edgeProposalStatus`（**保留全部现有接线**） |
| 节点提议 accept/reject | `selectedNodeProposals` + `proposalDecision.mutate`（loom 抽屉无此段，但已接线+有价值 → **保留**为额外 `.drawer-sec`） |
| 近活动 | `selectedActivity`/`buildNodeActivity`（loom 抽屉无，活动在详情页；这里**保留**为额外段，重写 `ActorPill`） |
| drawer-foot | `router.push('/knowledge/'+selected.id)`（router 已 import） |

## 4. 缺口 → 处理（不 mock；同 slice-2/3 FSRS gap）

| loom 字段 | 后端 | 处理 |
|---|---|---|
| head `tag · kind` | KnowledgeNode 无 tag/kind | tag = `id.slice(0,8)`（同 slice-3）；kind drop |
| node-metrics 第 3 格 **decay** | 无 FSRS/decay | **不 drop 留空 → 换成真实 mesh count**（`edgeCountByNode.get(id)`，「关系」），填满 3-col grid 用真实数据 |
| 边提议 `confidence %` | `EdgeProposalEvent.payload` 无 confidence（有 weight/cost/task_run_id） | **省略 %**（或显示 weight）；不假造 |
| 边提议「反向」 | loom 是本地 dir-toggle | **保留当前 server `reverse` 语义**（写后端，比本地 toggle 更全） |

## 5. Touch 文件清单

**MODIFY**：`app/globals.css`（追加 `.drawer-sec-h`/`.node-metrics`/`.nm*`/`.edge-prop*`，banner「LOOM KD-DRAWER LAYER — Slice 3b」，collision-check）· `app/(app)/knowledge/page.tsx`（重写 detail-drawer 段 + EdgeProposalCard + 节点提议行 + ActorPill/KnowledgeRelation helper；加 inline `useFocusTrap`+`drawerRef`；退役本段 legacy）。
**REUSE（不动）**：所有 query/mutation/memo/selection 数据（buildTree/selectedEdges/selectedPendingEdges/selectedNodeProposals/selectedActivity/edgeProposalDecision/proposalDecision）· slice-1/2 的 `.drawer`/`.scrim`/`.drawer-sec`/`.rel-row`/`.rel-tag-*` CSS · `useFocusTrap`/`Ring`/`Btn`/`IconBtn`/`LoomIcon`/`Badge` primitives。
**KEEP-LEGACY（slice-3c 退役）**：`EdgeCreateForm`（L1018-1114，含 `Card`/`Button`）· cytoscape `KnowledgeGraph` + chrome · `MasteryBadge`/`SuggestionKindTag` import 若仍被 edge-create/graph 引用则留（grep 确认后再删）。drawer 段退役 `MasteryBadge`（head）、close `Button`、edge-prop 的 `Icon`/`SuggestionKindTag`/`Button`、`ActorPill`/`KnowledgeRelation` 的 `Icon`。
**KEEP-LEGACY-CSS（不删，单独 cleanup pass）**：`.detail-drawer`/`.dd-*`/`.edge-proposal`/`.ep-*`/`.proposal`/`.relation` 等 legacy CSS（`.edge-proposal` 32 处引用、`.proposal` 20 处 → grep 确认无其它页面用才删；本刀只让 page 不再用它们，CSS 留待 cleanup）。

## 6. 风险 + 缓解

- **prop 线程 / 重构**：drawer 就地 restyle（不抽组件），保留所有 selection memo 引用 → 降低破坏 mutation 接线的风险。build + 手验「点节点开抽屉 + 4 个边 action + 节点 accept/reject」仍 working。
- **focus-trap**：inline `useFocusTrap(!!selected, () => setSelectedId(null), drawerRef)`；`role=dialog`+`aria-modal`（biome useSemanticElements 可能要 ignore，同 slice-1/2 抽屉，justified）。
- **CSS 冲突**：新类（`.node-metrics`/`.nm`/`.edge-prop*`/`.drawer-sec-h`）grep 确认 globals 无 → 全局 port（drawer 类本就全局 scope）。`.drawer-sec > h4`（slice-2）vs loom `.drawer-sec-h`：本刀用 `.drawer-sec-h` div 段头，不动 slice-2 的 h4 规则。
- **legacy CSS 留存**：本刀不删 legacy drawer CSS（多页引用），只让 page 改用 loom 类；避免误删回归其它 surface。
- **build = CSS+route gate**；额外手验抽屉交互 + 移动断点 + focus/Esc。

## 7. Build order + verify gate

新 CSS 类（globals）→ 重写 drawer 段（scrim+focus-trap+head+metrics+层级+关系+边提议+节点提议+活动+foot）+ EdgeProposalRow/ActorPill/KnowledgeRelation → **verify**：typecheck / lint / audit×3 / build / 点节点开抽屉 · 4 边 action(accept/reverse/change-type/dismiss) · 节点 accept/reject · foot→详情页 · Esc/scrim 关闭 · 移动断点。独立 review + push + PR（**你 merge**）。

---

*批准后按 build order 实施。本刀只 loom 化 NodeDrawer + 提议交互；EdgeCreateForm + graph 周边留 slice-3c。legacy CSS 留待单独 cleanup。*
