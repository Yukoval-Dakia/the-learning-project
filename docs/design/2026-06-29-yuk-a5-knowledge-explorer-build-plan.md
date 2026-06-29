# A5 知识探索面 — Build Plan（6-map code-ground + 分片）

形态轴 A5（YUK-354 子）。本 doc 是 A5 多片实施的 single source：6 个并行 reader 的 code-ground 发现 + 按依赖就绪度的分片 + 各片 spec。2026-06-29。

## 为什么 A5 必须分片

A5「知识探索面」是形态轴依赖跨度最大的屏。6-map code-ground 证明各组件后端就绪度天差地别——从「几乎纯 wire」（mastery band）到「一等节点根本读不出，要建 backend」（误区）。一个 PR 不可能内聚交付，故拆成独立可 merge 增量，按就绪度易→难推。

## 6-map code-ground 发现

### ① mastery 档/置信（`src/server/mastery/state.ts`）
- 出口 `getMasteryProjection(db, ids, 'knowledge')` → `Map<id, MasteryProjection>`（never-attempted 缺席 map = 冷启）。
- `MasteryProjection` 已有：`mastery`(p(L) 点估计 0-1) · `mastery_lo`/`mastery_hi`(σ 真实置信区间) · `low_confidence`(theta_se≥1) · `theta_se` · `evidence_count` · `success/fail_count` · `beta`(代表性 β 难度锚)。
- **lo/hi 区间 + 低置信旗 + evidence 全现成，不需新读模型**。
- 缺 2 个纯展示派生：(a) 4 档 band 映射（萌芽/成长/稳固/精熟；现只有 3-tone `masteryTone` @ `knowledge/ui/mastery-tone.ts:17`，扩 4 档安全，dependency-free leaf）(b) hard/soft 源二态（`evidence_count>0→hard`/`===0→soft`，或 `calibration-maturity.cold_start`）。
- ⚠️ **避坑**：`state.ts` 满屏的 `'hard'/'soft'` 是 `item_calibration.track`（题难度轨道），**不是** A5 的校准/先验源二态。绝不复用该字段。
- 现成离散映射：`masteryTone`(3-tone 颜色) 和 `calTier`(3-tier 置信档) 都不是 4 档 mastery band，全仓 grep `masteryBand`/4 档 0 命中。

### ② 三维 R·p(L)·difficulty（`mastery/{state,item-calibration,personalized-difficulty}.ts` + `fsrs/state.ts`）
- **p(L)+difficulty 已 co-located** 在 `getMasteryProjection`：β = `MasteryProjection.beta` = `getRepresentativeKcBeta`(该 KC hard-track 题 `COALESCE(b_calib,b_anchor,b)` 中位数，`state.ts:603`)，内部已 join。
- **R 缺**：SoT `material_fsrs_state`（per-KC `subject_kind='knowledge'`），单 KC 读 `getFsrsState('knowledge',kc)` + 纯函数 `retrievabilityForKc(state,now)`→R(t)∈[0,1]（`practice/server/fsrs.ts:109`）。要补一条 batched `WHERE subject_kind='knowledge' AND subject_id IN(ids)` 逐行过 retrievability。接线非造轮子。
- **三轴正交守住**：各单写者 + 显式注释（`applyKgSoftLayer` NEVER writes mastery_state；`getRepresentativeKcBeta` READ-ONLY never writes b）。注意 difficulty→p(L) 是**读方向依赖**（β 进 pfaLogit），非 writeback，符合红线（ADR-0035 正交指**写**互不污染）。R 轴对另两轴零读耦合。
- 形状：p(L) 完整 band（point+lo/hi+low_confidence）几乎对齐 A5；difficulty β 裸中位数无 CI（要从 `calibration_weight/n` 派 source/置信）；R 纯标量（band/区间/source 全要新造）。

### ③ frontier（真读模型 = `src/capabilities/practice/server/learnable-frontier.ts`）
- ⚠️ **假朋友**：`target-discovery.ts`(题供给缺口扫描) / `adaptive-bias.ts`("frontier LLM" 指大模型) / `knowledge-readers.ts`(BFS 局部变量) 里的 "frontier" 全是同名假朋友。
- 真模型 `learnableFrontierResolved(db)` → `{kind:'sparse'|'dense'|'overflow', ids}`（`WITH RECURSIVE` prereq 闭包 + `pL<0.7` 自身未掌握 ∧ 每个传递先决 `pL≥0.7`）。`learnableFrontier(db)`→薄包装裸 `string[]`。
- **缺口**：(a) 出口裸 `string[]`/`{kind,ids}`，**无 HTTP route**（`api/` 下零引用）；(b) `reason` 原料在 `prereqsByFrontier` Map 算了但**用完即弃**；(c) `propose`/`lowConf` 不在 frontier 读里——只活在独立 `frontier_fill_nightly` job（冷启 bootstrap 写 propose-only 低置信 prereq 边）。
- 现有消费者非 UI route：`stream-store.ts:205`（组流第5源）+ `frontier_fill_nightly`（cron job）。

### ④ 误区节点（散在三处，A5 一等节点读不出）
- `misconception` 表（`schema.ts:122`）**DORMANT 零 writer**（全仓无 insert）+ 缺 status/source/seen/evidence/targets + `misconception_edge`(→KC targets) **deferred**。空骨架。
- `kc_typed_state`（`schema.ts:955`）活的 per-KC 投影（`typed_state: no-evidence|confused-with-X|mastered` + `lifecycle: open|resolved` + `evidence_event_ids`），但**无外部 reader**，词表 ≠ A5 的 `active|fading|retracted`。
- conjecture 提议（event/inbox，`ConjectureProposalChange`）：唯一 reader `prep-desk.ts` 只取 pending cap3 且 **strip 掉 conf**（反内疚铁律）。
- **A5 字段映射**：belief✓ · status✗(无 fading) · source✗(无列) · conf△(被 strip) · seen✓(recurrence_count) · evidence✓ · targets△(单 knowledge_id 非多 target，edge deferred)。
- → **L 量级**：要么给 `misconception` 表接 writer+补列+建 edge，要么写新 per-KC 派生读 join `kc_typed_state`+conjecture events。两者都不存在，且 conf 撞反内疚铁律（非数字服务端信号）。

### ⑤ 设计组件（`docs/design/loom-refresh/project/screen-knowledge-a5.jsx` + `data-knowledge-a5.jsx`）
- A5 是一组 helper（非独立 screen），被 `screen-knowledge`(图谱主面) + `screen-knowledge-detail`(节点详情) 消费。
- 导出：`A5_BANDS`(萌芽/成长/稳固/精熟) · `masteryBand` · `BandChip` · `FrontierRail` · `NodeComposite`(三维折叠) · `TransferList`(迁移) · `MisconceptionList`/`MisconceptionCard` · CDM/IRT 诊断件 · `MasteryBand`(复用自 A1)。
- ⑥治理核心：一切掌握/难度走离散档 + 置信区间 + 来源二态（hard 硬轨校准/soft 软轨先验），**绝不裸数字**。
- ⚠️ **设计 mock vs 真模型**：设计 `masteryBand` 用 `mastery(0-100)` + `evidence` 阈值**估算** lo/hi（band±spread）；真实后端有 `mastery_lo/hi`(真 σ 区间) + `low_confidence`——实现用**真信号**，不照搬 mock 估算。

### ⑥ 前端落点
- 落点 = `src/capabilities/knowledge/ui/`：`KnowledgeDetailPage.tsx`(节点详情) · `KnowledgePage.tsx`(图谱主面) · `NodeDrawer.tsx` · `MeshGraph.tsx` · `mastery-tone.ts`(3-tone，扩 4 档起点)。

## 分片（易→难，逐片独立 PR）

| Slice | 组件 | 后端 | 量级 |
|---|---|---|---|
| **S1** | BandChip + mastery band | `getMasteryProjection` 全现成 + 2 纯派生 | **S~M** |
| **S2** | FrontierRail | `learnableFrontierResolved` 现成，缺 route + reason/propose/lowConf 暴露 | **M** |
| **S3** | NodeComposite 三维折叠 | p(L)+β 现成，补 batched R 读 + 三维 band/区间装饰 | **M** |
| **S4** | MisconceptionList | 一等误区节点读不出，建 backend 或新派生读 + ⑥反内疚 | **L**（再拆 backend+UI） |
| S5 | TransferList/CDM/IRT 深度诊断 | nodeExtra 各专 backend 依赖 | 待 map |

## S1 详细 spec（本片）

**目标**：BandChip = 知识点/树/图行上替换裸 mastery% 的「离散档 + 置信 + 来源」chip。⑥治理首个载体。

**后端/纯逻辑**（新建 `knowledge/ui/mastery-band.ts` 或 `core/` 纯函数 + unit）：
- `masteryBandIdx(p: number): 0|1|2|3` — 4 档阈值（萌芽<0.4/成长<0.6/稳固<0.8/精熟，参考 `masteryTone` 0.67/0.45 但 4 档；阈值具名常量）。
- `masteryBandFromProjection(proj)` → `{ band, lo, hi, source, lowConf }`：band=`masteryBandIdx(mastery)`；**lo/hi 用真实 `mastery_lo`/`mastery_hi` 各自过 `masteryBandIdx`**（非 mock 的 evidence 估算）；source=`evidence_count>0?'hard':'soft'`；lowConf=真实 `low_confidence`。冷启（缺席 map）→ band 未知态 + soft + lowConf。
- 红线：纯展示派生，绝不写回任何轴；不碰 item_calibration.track 的 hard/soft（撞名）。

**读模型 wire**：`node-page.ts:195` 已调 `getMasteryProjection` 但只 surface `.mastery`——扩展暴露 `mastery_lo/hi/low_confidence/evidence_count` 给前端（或新 thin 读把 projection 映射成 band 形状）。`knowledge-api.ts` 加/扩 query。

**前端**（PORT `screen-knowledge-a5.jsx` BandChip）：
- `BandChip` 组件：`band-chip src-{hard|soft}{ is-low}` + dot + 档名 + 低置信标记。title 含「区间 lo–hi · 软轨先验/硬轨校准 · 低置信」。
- 落点：替换 `KnowledgeDetailPage`/`KnowledgePage` 树/图行上的裸 mastery%。CSS PORT `knowledge-a5.css` 的 `.band-chip*` 进对应 css。
- ⑥：绝不渲染裸概率；档/区间/来源/低置信全定性。

**红线**：禁嵌套三元（含链式）· 魔数→具名常量 · 三轴正交（band 是 p(L) 轴展示，不耦合 R/difficulty）· 设计 mock 的 evidence-估-lo/hi 用真 mastery_lo/hi 替代（注释标）。

## 后续片备注
- S2/S3/S4 各自 worktree + PR，开工前重读本 doc 对应 map 段 ground。
- S4 误区是真 backend 工程，开工前 owner 决策：建 `misconception` 表 writer+edge vs 新派生读（关系到是否动 schema + 反内疚 conf 表达）。
- Linear 断连期间本 doc 是 repo-side single source；恢复后同步成挂 YUK-354 的 Linear Document。
