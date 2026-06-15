# event-sourcing 地基改造 · 设计（YUK-363，完整落盘）

**Date**: 2026-06-15
**Status**: Design-complete（4 路深挖 + cross-统合，喂 ADR-0044 + 分 wave 实施）
**生成**: workflow `event-sourcing-redesign`（5 agent / 651k tokens / 4 路深挖 + 统合，全 opus，file:line 核验）
**触发**: ADR-0041 checkpoint 腿「派生重算红利」前提被 `copilot-omnipotent-map` 证伪（系统是 event-logged 非 event-sourced）→ owner 拍板走大改造。
**Related**: ADR-0041（checkpoint 腿，被本设计 §6 修正）· ADR-0035（三轴正交，θ̂/FSRS 快照不破）· ADR-0006（event=SoT）· ADR-0042（选题引擎，存 π_i）· B1 载体（#414，θ̂/FSRS 写路径，本设计用快照不重写）· YUK-358 笔记域（artifact Wave 3 合流）

---

# 第一部分 · Cross-统合设计（权威）

三个关键前提全部确认:
- `event.subject_kind` 注释枚举(`:609-610`)有 `knowledge_edge`/`chip`/`query`,**确实无 `question_block`**(probe-1 补字段 #5 准确)。
- `persistStructured` 写 `writeJobEvent`(`:143`)且 payload 是外部传入的 `Record<string, unknown>`,structured 全树确实没进 payload(probe-1 准确)。
- `updateThetaForAttempt` 循环里 `s.theta`(before) + `newTheta`(after) + cold-start `?? 0` 哨兵全部在手(probe-2 快照收集点准确),且每 KC 走 `pg_advisory_xact_lock`。

四路勘察的关键坐标互相一致且与代码吻合。地基核验通过,我现在产出完整改造设计草案。

---

# YUK-363 Event-Sourcing 地基改造 — Cross-统合设计草案

> **统合者裁定**:四路勘察互相印证且与代码吻合,核验通过。本草案在四路基础上做**全局编排 + 否决裁定 + ADR-0041 修正**,是 YUK-363 ADR + 分 wave 实施的地基。
> **status: design-in-progress**。本草案未实施任何代码;落地按 §5 分 wave。

---

## 0. 统合者裁定:三个改变设计形态的全局事实

四路勘察各自从一个面切入,合起来浮出三个**只有交叉才看得见**的全局事实,它们决定整个改造的形态:

**事实 A — 这不是「引入 event sourcing」,是「把 event-logged 升级为 event-sourced」,且九表分两类不是一类。**
probe-4 给出的二分(A 类 derived / B 类命令式实体)是整个 wave 策略的脊椎,但 probe-1 的审计揭示 B 类内部**还有自足度的三段光谱**:`knowledge_edge`(generate payload 已是完整快照,几乎自足)→ `knowledge`(propose payload 自足,但 accept 时 **id 当场生成无留痕** = 重放 id 漂移硬阻断)→ `artifact`/`question_block`(创建/编辑事件根本不进 canonical event 表,或 payload 只有 version 号 = 完全不自足)。**裁定:wave 序必须沿「自足度光谱」从右(已自足)向左(完全不自足)推进,而非沿表的业务重要性。**

**事实 B — owner 拍板的「快照 vs 重算」二分,在级联 revert 器里会撞上一个 probe-2/probe-3 单独看不见的语义裂口。**
probe-2 诚实指出:**纯快照恢复无法「抽掉中间一次 attempt 后让后续重新生效」**(那需要重放,owner 否决)。probe-3 诚实指出:**结构性 fold 能单点 revert(重算自动处理后续),θ̂/FSRS 强制级联**。两者交叉的后果:**同一个级联里,结构 effect 是「局部可逆」,θ̂/FSRS effect 是「倒带式不可逆 + 强制级联 retract 后续」**。编排器不能假装两类对称。**裁定:级联编排器必须按 effect 类型路由 revert 语义,且 θ̂/FSRS 触及「跨 turn 已练后续」时诚实拒绝(见 §7 天花板)。**

**事实 C — ADR-0041 checkpoint 腿的「派生重算红利」前提被本改造证伪,但证伪方向是「部分成立」而非「全错」。**
probe-3/probe-4 都点出 ADR-0041 假设系统已 event-sourced(撤事件→派生自动重算)。真相:**结构半边的红利成立(fold 重算确实自动),θ̂/FSRS 半边的红利不成立(必须快照恢复 + 级联)**。**裁定:ADR-0041 不是推翻而是劈成两半改写(见 §6)。**

---

## 1. 重算引擎

### 1.1 通用机制:`fold(events) → projection`,纯函数在 core,IO 包壳在 server

统一签名(放 `src/core/projections/<table>.ts`,纯函数无 IO,与 `getCorrectionStatuses` `corrections.ts:41-106` 同构):

```
fold<Row>: (events: KnownEventT[], opts?) => Row[]
```

- **蓝本**:`getCorrectionStatuses`(`ORDER BY created_at, id` + switch 累积终态)和 `getEffectiveTruth`(状态机 step)是现成模板,只是目前只 fold 出**状态标签**,本改造扩成 fold 出**完整业务行**。
- **IO 包壳**:`src/server/projections/<table>.ts` 拉事件(用 `event_subject_idx`,`schema.ts:638`,已存在)→ 调 core reducer → upsert 写回(同 `upsertFsrsState` `fsrs/state.ts:36-58` 的 `onConflictDoUpdate` write-through 模式)。
- **增量默认 + 全量兜底**:热路径走增量(单实体级,从 event 的 subject_id + payload 内引用 id 推导受影响集);`scripts/rebuild-projection.ts` 全量 truncate+fold 用于 backfill / drift audit / 灾难恢复。**理由**:全量每写都跑不现实(event 表无限长);纯增量易累积漂移,故全量当对账真相而非热路径。

### 1.2 物化策略:四张结构表全部 materialized(write-through),不做读时 fold

- 项目趋势已从 view 走向物化(`mastery_state` 取代 `knowledge_mastery` view,ADR-0035)。结构表是高频读 + 被大量 join 引用(edge FK → knowledge.id;artifact.knowledge_ids),读时 fold = 每次 KG 渲染重放全历史,不可接受。
- **裁定:materialized write-through。** projection 表降级为「事件流的缓存」,真相在 event。乐观锁 `version`/`expected_version` **保留**(reducer 算出的 version 仍走 `WHERE version=expected` 守门,防并发双写)。view 范式(`knowledge_mastery`)留给纯统计派生维,不纳入本引擎。

### 1.3 每个结构性表的 reducer 需求

| 表 | reducer 输入事件(按 `created_at,id`) | 累积逻辑 | 跨实体注意 |
|---|---|---|---|
| **knowledge** | `propose`+`rate`(同 subject 链)、`experimental:knowledge_{reparent,merge,split,archive}` | propose+rate(accept)→ INSERT(用补字段 #1 materialized_ids 锚 id);reparent→set parent_id;archive→set archived_at;merge→set merged_from+archive from_ids;split→archive+INSERT children | merge/split touch 多行,reducer 以**整批 events**为单位 fold,非 per-entity 独立 |
| **knowledge_edge** | `generate`(subject=edge_id)、`rate`(edge,`edge_op:archive`) | generate(create)→upsert(subject_id=PK);generate(archive)→set archived_at | subject_id===edge.id 已成立,无需补字段 |
| **artifact** | `generate`(create,补 #4)、`body_blocks_edit`(补 #2)、`note_refine_apply`(已自足)、`section_edit`、生命周期 status(补 #7) | create→INSERT;每 edit→取 payload 全量 body_blocks,bump version+追 history | merge_questions touch primary+N blocks,同 knowledge merge 处理 |
| **question_block.structured** | 新 `EditQuestionBlockStructured`(补 #5/#6) | 起始=OCR extract 时 structured;每 edit op→取 payload 快照替换树 | figures 与 structured 同 payload(splitStem 重指 figures) |

### 1.4 Event payload 补字段清单(自足性审计结论)

事件唯一真相的前提:`fold(events for subject)` 必须**不读 projection 表**重建整行。逐表审计后的补字段(probe-1 全表准确,统合者按 wave 优先级重排):

| # | 优先级 | 位置 | 补什么 | 为何硬阻断 |
|---|---|---|---|---|
| 1 | **P0/硬阻断** | `RateEvent.payload` `known.ts:215-218` | `materialized_ids?: string[]`(accept 时把 `applyProposeNew:253` 当场 `newId()` 生成的节点 id 写进) | 不补则重放生成**不同的 knowledge.id** → 引用它的所有 edge/artifact.knowledge_ids 全断。这是把命令式 id 钉进事件流的关键 |
| 2 | P0 | `body-blocks-edit.ts:101-105` | payload 加 `body_blocks`(新全量树) | 现 payload 只有 version 号,不可重放 |
| 3 | P0 | `note_generate.ts:213-228` | 同 tx 写 `GenerateArtifact` event | AI 生成正文完全不进事件流 |
| 4 | P0 | `GenerateArtifact.payload` `known.ts:193-198` | 加 `body_blocks?`/`type`/`intent_source`/`source`/`parent_artifact_id`/`knowledge_ids`/`tool_kind`/`attrs` | 创建事件不足以重建 artifact 行;5 处创建散点统一归一到此 action |
| 5 | P0 | 新 `EditQuestionBlockStructured` KnownEvent | `subject_kind:'question_block'`(schema 注释 `:609-610` 现无此值)+ 编辑后 structured 全树快照 | structured 编辑 payload 不含编辑后的值 |
| 6 | P0 | `block-structured-edit.ts:143` | `writeJobEvent` → `writeEvent`(canonical) | job_events 不在事件真相层,不进 outbox,不被重算覆盖 |
| 7 | P1 | artifact 生命周期 status 转移 | `experimental:artifact_status` event | generation/verification status 转移无事件(owner「全部 projection 纳入」→ 应纳入) |

> **统合者补充:knowledge accept 的 join vs inline 决策。** probe-1 建议保持 rate→propose 两跳 join(链已存在)。**裁定:保持 join,但 #1 的 `materialized_ids` 必须 inline 进 rate payload**——因为 join 能拿到 mutation body,但拿不到「这次 accept 实际生成的 id」。两者不冲突:mutation 形态走 join,生成的 id 走 inline。

---

## 2. 快照机制(θ̂/FSRS)

### 2.1 形态:独立聚合 snapshot event,经 experimental escape hatch,不扩 attempt payload

**裁定采纳 probe-2 的「独立 event + 单 attempt 单聚合快照」**,三条理由压倒「扩 attempt payload」:① 一次 attempt 更新 N 个 θ̂ + M 个 FSRS,塞 attempt payload 让 schema 膨胀且职责混淆;② 单写者红线(`step9-invariant-audit.test.ts:156/170`)要求快照内容由 `src/server/mastery/` 和 `src/server/fsrs/` 各自产出;③ 已有精确先例 `experimental:question_structure_edit`(`proposal-appliers.ts:668`,独立 event 带 before/after)。

走 `ExperimentalEvent` 松守 fallback(`experimental.ts:134`,**不**进 `RESERVED_EXPERIMENTAL_ACTIONS`),`action='experimental:state_snapshot'`,`subject_kind='event'`,`subject_id=caused_by_event_id=attemptEventId`。

### 2.2 快照 payload schema

```ts
// experimental:state_snapshot — subject_kind='event', subject_id=attemptEventId
{
  attempt_event_id: string,
  source: 'review_submit' | 'paper_submit',
  theta_snapshots: Array<{
    knowledge_id: string,                  // = mastery_state.subject_id
    before: null | { theta_hat, evidence_count, success_count, fail_count, last_outcome_at },
    after:  { theta_hat, evidence_count, success_count, fail_count, last_outcome_at },
  }>,
  fsrs_snapshots: Array<{
    subject_kind: 'knowledge' | 'question',
    subject_id: string,
    before: null | { state: FsrsStateSchemaT, due_at, last_review_event_id },
    after:  { state: FsrsStateSchemaT, due_at, last_review_event_id },
  }>,
}
```

- **`before: null` = cold-start 哨兵**(已实证:`state.ts:194` `?? 0` 冷启、`fsrs/state.ts:72` 返 null)。**revert 时 before=null 必须删行**,否则留下伪造的 0-evidence 行。这是 revert 正确性的核心。
- **不存中间量**(b 锚/credit/k);可选存 `attempt_outcome`/`b_used` 作审计痕迹。
- **FSRS before/after 复用 `FsrsStateSchemaT`**(与 review event 的 `fsrs_state_after` 同 schema),不引入新 schema。快照补的是 review event **缺失的 before 半边 + θ̂ 全部**。

### 2.3 写入点(守单写者,五者同 tx)

`updateThetaForAttempt`(`state.ts:143-224`)循环里已持有 `s.theta`(before,`:212`)+ `newTheta`(after,`:214`)→ 函数返回 `ThetaSnapshotEntry[]`。FSRS 调用方(`submit.ts:389-431`)已持有 `prevStateRow.state`(before)+ `update.stateAfter`(after)→ 收集 `FsrsSnapshotEntry[]`。然后 `submit.ts`/`paper-submit.ts` 在**同一 `db.transaction`** 内(attempt event + judge event + FSRS upsert + θ̂ update + **快照 event** 五者原子)emit 聚合快照 event。回滚则全无。

> **统合者形态决定(否决权范围内的可拍点):聚合单条 vs per-axis 拆开。** probe-2 推荐聚合单条,理由是 attempt 是原子 revert 单元。但 §4 的级联编排 + §0 事实 B 显示 **θ̂ 轴和 FSRS(R)轴的级联触发条件不同**(judge_retraction 只回 p(L) 不碰 R,ADR-0035 决定6;D15 重判 gate②b)。**裁定:payload 一条 event,但内部 `theta_snapshots[]` 与 `fsrs_snapshots[]` 两段独立可分别 revert。** 这同时满足「attempt 原子单元」(一条 event)和「三轴正交」(两段独立回滚),不破 ADR-0035 §决定6 的「R⟂p(L) 不对账」红线。

### 2.4 单点 revert 恢复

放 `src/server/mastery/` + `src/server/fsrs/`(守单写者):读 snapshot payload → 每个 theta_snapshot:`before!==null` 走 `upsertMasteryState`(`state.ts:52`)写回;`before===null` 走新增 `deleteMasteryState`(单写者内)。FSRS 对称(新增 `deleteFsrsState`)。然后写一条补偿 `CorrectEvent(correction_kind='retract')`,`subject_id=caused_by=attemptEventId`(复用 `revert-auto-enroll.ts:113` 模式),让读层(`effective-truth`)也把原 attempt 标非 active —— **物化状态 + 读层投影双轨一致回滚**。

---

## 3. 级联 revert

### 3.1 caused_by 图真实拓扑(设计的核心约束,probe-3 关键发现)

事件因果图不是单一 caused_by 边,而是三类边交织:

| 边 | 列 | 语义 | 是否进递归 |
|---|---|---|---|
| **A. caused_by 正向** | `caused_by_event_id → id` | 由那条引起 | **进**(主递归) |
| **B. subject 指向 event** | `subject_id → id`(当 `subject_kind='event'`) | judge/rate/correct 作用于 prior event | judge 因用 caused_by 挂载自动进;rate/correct **不进** |
| **C. 补偿边** | correct 事件 `caused_by=subject_id=target` | 撤销动作本身 | **必须排除** |

**核心陷阱**:`correct` 事件**同时**用 caused_by 和 subject_id 指回 target(`event-correct.ts:69,72`)。朴素反向遍历会把**补偿事件本身**当下游再次补偿 → 死循环/二次撤销。`getEventChain`(`queries.ts:963`)已用 `ne(action,'correct')` 给出正解 —— **遍历器必须沿用同一过滤**。judge(`getJudgeForAttempt:351` 证明用 `caused_by=attemptEventId`)是真下游,**必须收**(撤 attempt 连带补偿其 judge,否则判分悬空)。

### 3.2 recursive CTE 遍历器:`collectCascadeFromCheckpoint`

**裁定:这是仓库第一个真 `WITH RECURSIVE`**(probe-3 实证 `tree.ts:29-35` 的 CTE 是 phase-deferred 从未落地,现有三处递归全是内存 JS)。落 `src/server/events/cascade.ts`(读路径纯 SELECT)。

```sql
WITH RECURSIVE cascade AS (
  SELECT e.id, e.action, e.subject_kind, e.subject_id, e.caused_by_event_id,
         0 AS depth, ARRAY[e.id] AS path
  FROM event e WHERE e.id = $checkpointId
  UNION ALL
  SELECT c2.id, c2.action, c2.subject_kind, c2.subject_id, c2.caused_by_event_id,
         cascade.depth + 1, cascade.path || c2.id
  FROM event c2 JOIN cascade ON c2.caused_by_event_id = cascade.id
  WHERE c2.action <> 'correct'        -- §3.1 陷阱：排除补偿事件
    AND c2.id <> ALL(cascade.path)     -- cycle guard
    AND cascade.depth < $maxDepth      -- 硬顶熔断（建议 64）
)
SELECT DISTINCT ON (id) * FROM cascade ORDER BY id, depth;
```

**护栏三件套**(承 CLAUDE.md「护栏两层语义」):① cycle guard(`path` 数组,与 pg 版本无关最稳);② depth limit(硬顶 64,turn 内实测≤几跳,是事故熔断非正常约束);③ node cap(外层 `LIMIT $maxNodes`,仿 `tree.ts:36` 5000;**截断时 `truncated=true` → 上层必须拒绝级联并要求人工**——截断级联 = 漏补偿 = 派生态半残)。

输出 `CascadeNode` 含 `reversibility: 'derived' | 'entity' | 'irreversible'` 标记(在 collect 阶段就标,让上层 PR diff 面如实展示「能干净撤/部分撤/不能撤」)。

### 3.3 反依赖序补偿 + 双路统一编排

放 `src/server/revert/cascade-revert.ts`。两条 revert 路径在编排器里统一为一个接口(承 §0 事实 B 的非对称裁定):

```
RevertableEffect {
  kind: 'structural_fold' | 'state_snapshot',
  reversibility: 'derived' | 'entity' | 'irreversible',
  revert(tx): Promise<void>
}
```

**编排步骤**:
1. `collectCascadeFromCheckpoint` → nodes(已 `depth DESC` = 反拓扑序,最下游先撤,保证撤一条边时它引用的上游还没撤,与 ADR-0041 反依赖序一致)。
2. 闭包内每个 event 映射成 0..N 个 `RevertableEffect`:结构 event → fold effect(revert=重放剩余 active event 重算 projection,**单点即可,自动处理后续**);attempt/review event → 找其 `experimental:state_snapshot` 子 event → snapshot effect(revert=§2.4 恢复 before,**强制级联倒带**)。
3. **预检诚实拒绝**:若任一 node `reversibility==='irreversible'`(触及已发生 attempt/review)或 `truncated===true`,**整体拒绝 + 告知边界**,不做半残级联。
4. 反序队列同一外层 tx 内依次 `effect.revert(tx)`,每个 effect 内部写各自补偿 CorrectEvent。失败整体回滚。
5. 补偿写完后,`getCorrectionStatuses`(`corrections.ts:42`)让所有读路径自动跳过 retract 行 —— **结构性派生态自动重算(ADR-0006 红利),θ̂/FSRS 靠 §2.4 显式写回**。

**统一基底**:两类都遵循 append-only + 补偿 event(`revert-auto-enroll.ts:113` 是共同基底),没有任一类 hard-delete event(θ̂ 的 `before=null→删行`是删**物化投影**行,event 永远 append-only)。

**θ̂/FSRS 级联范围 = caused_by 因果闭包(策略 A1),非「时序上所有后续」。** 这把时序收窄成因果,避免误撤无关并行 attempt。**冲突护栏**:恢复某 subject 的 before 前断言「当前物化态 == 待恢复快照的 after」,不等则 409 拒绝(仿 `paper-submit.ts:437` changed-content 409),防静默冲掉范围外更新。

### 3.4 caused_by 一致性补全(artifact inline 写盲点 + worker half-wired gap)

probe-3 实证 `author-artifact.ts:108` 的 artifact 实体写**本就不该带 caused_by**(artifact 表无此列、不该有);其因果留痕走 `mirrorEvent:'when_causal'`(`:151,277`)→ mcp-bridge 写 mirror event 带 `caused_by_event_id: ctx.causedByEventId`(`mcp-bridge.ts:289`)。

**补全清单**:
- ✅ 已正确:proposal-tools 全部 propose 写(14 处)、mcp-bridge mirror、chat reply。
- 🔴 **头号硬前置 — worker 进程 `ctx.causedByEventId` 透传**(ADR-0041:55 点名 half-wired gap):durable copilot job 跑在 worker(`scripts/worker.ts`),若 bootstrap 没把 user_ask event id 透传进 `ToolContext.causedByEventId`,durable run 内所有 mirror/propose 事件 `caused_by=null` → **整条下游脱链,级联 revert 漏收**。核验点 `src/server/ai/tools/bootstrap.ts` + `scripts/worker.ts`。**裁定:这是级联 revert 正确性的硬前置,优先级高于一切 rename。**
- 🟡 `update_artifact`(`author-artifact.ts:183-266`,无 writeEvent):级联撤 update 需特殊处理(恢复 v(n-1) html 而非软删整个 artifact),靠 mirror args 链(`:27-33`)。
- ✅ chip 路径(`chat.ts:736` 用 chipEventId):chip 也是合法 checkpoint 锚 —— `checkpoint_id` 定义涵盖「user_ask OR chip event」两类锚。
- ✅ 非 copilot 写路径(ingestion/agency/notes)的 caused_by 是各自领域链,遍历器以 user_ask/chip 锚 + caused_by 反向天然只收锚下游,不跨界。

---

## 4. 迁移策略

### 4.1 按 §0 二分:A 类双轨快照,B 类 genesis-event backfill

**A 类(mastery_state/material_fsrs_state/item_calibration)— 不需要 backfill genesis event。** attempt/review 事实早已只写 event,历史 event 完整,「从 event 重算」对历史天然可行 —— 缺的是重算/快照算子,不是数据。owner 拍快照方案,落法 = 保留命令式在线更新 + 写路径旁 append before/after 快照 event,revert=恢复快照。

**B 类(结构表)— genesis-event backfill。** 已有 B 类行没有完整 propose/generate 历史的,为每行生成一条 `genesis`/`import` 补偿 event(`actor_kind='system'`),让 event 流当前折叠态 == 现状 projection 行。precedent:`scripts/seed-synthetic.ts:362,483`「先 writeEvent 后 upsert projection」的正确序,backfill 反向用同一序补齐。

### 4.2 双写期 + 切真相源时序

中间必须有双写校验期:写路径同时(a)写 projection(旧真相)和(b)append event + 立即 `fold(events)==projection` 校验,一致再切真相源指针。

**切换难度(按 §0 自足度光谱 + FK 拓扑,`FK_ORDER` 实证)**:

| 难度 | 表 | 理由 |
|---|---|---|
| 最易(已半成) | material_fsrs_state / mastery_state / item_calibration | 单写者就位,零 FK,已声明 derived;只补快照算子 |
| 中 | knowledge_edge(已禁外部 raw insert)→ knowledge(FK 序) | knowledge_edge 最自足,knowledge 补 #1 id 留痕 |
| 难 | goal / mistake_variant / learning_item | 写点中等,有现成 propose/rate 路径,learning_item 7 写点跨三 capability |
| 最难 | artifact(14 单写者跨多 capability)/ question_block(12 写点) | event-source artifact = 重设计 notes 域写契约,与 ADR-0040/YUK-358 笔记域 re-think 冲突面最大 |

**切换顺序铁律**:knowledge → knowledge_edge(FK from/to→knowledge,`schema.ts:797-800`);artifact 末位。

### 4.3 测试冲击与 hermetic 契约扩展

实测 372 个 `.test.ts`(207 走 DB);碰九表的:event 155 / knowledge 125 / artifact 64。双写期保证 `fold==projection`,**多数读路径测试无需改**(读 projection,projection 仍在);真正受冲击的是**写路径单测 + 单写者 invariant 审计**。

**hermetic 契约新增不变量**:测试种数据必须「先 event 后 projection」(或只种 event 让 fold 产 projection),否则 fold 校验误报。`step9-invariant-audit.test.ts` 扩**反向断言**:每个 A 类写者旁必须有对应 snapshot-event append(防「写 projection 不 append event」静默漂移)。新增 `pnpm audit:projection`(仿 `audit:schema`):全量 fold diff 重算 vs 现表,非空 diff = drift fail —— 这是「事件=真相」的机器守门,接 CLAUDE.md audit 家族。

---

## 5. 分 Wave

| Wave | 内容 | 独立可验证判据 | 与 copilot 并行关系 |
|---|---|---|---|
| **Wave 0（试点）** | `mastery_state` + `material_fsrs_state` 快照可逆 + recursive CTE 遍历器**骨架** + `ctx.causedByEventId` worker 透传补全 | `restore(snapshot)==命令式写态` + revert 幂等(单表闭环);遍历器单跳→多跳对照 `getEventChain` 黄金断言 | **与 reach/endurance 并行起跑** |
| **Wave 1** | `knowledge` + `knowledge_edge` 真 fold 重算 + genesis backfill + 补字段 #1 + ADR-0034 一致性闸(环/方向/传递冗余,目前零实现) | `fold(events)==命令式写结果`黄金断言;`audit:projection` 零 drift | 并行 |
| **Wave 2** | `goal` + `mistake_variant` + `learning_item` | 同 Wave 1 fold 黄金断言 | 并行 |
| **Wave 3** | `artifact` + `question_block.structured` + 补字段 #2/#3/#4/#5/#6/#7 | fold 黄金断言;`job_events` 结构编辑分支删除验证 | **与 YUK-358 笔记域 re-think 合流设计**,不平行造两套 artifact 写契约 |
| **横切** | caused_by recursive CTE + 级联 revert 编排器 | Wave 0 引入骨架,各 wave 复用 | checkpoint 腿 **gated 在本改造之后** |

**为何 Wave 0 选 mastery_state + material_fsrs_state(非结构表)**:① 单写者已就位 + invariant 审计已强制;② owner 已拍快照方案,无需重写在线更新逻辑;③ 直接兑现 gate②c(公式调参时从 event 重算既有 p(L))+ D17 推翻后「慢热资产不可丢必须可恢复」(#414 刚 merged);④ 解锁 judge_retraction 回滚(gate②b)。风险最低、依赖最少、收益最高。

**与 copilot reach/endurance 的并行关系(关键澄清)**:reach/endurance 两腿与本改造**正交可独立先做**(`2026-06-15-copilot-reach-endurance-design.md:5,87` 双向确认,几乎不用新表,所有写汇进同一确定性 applier 层)。**唯一耦合点是 checkpoint 腿(ADR-0041)**:其「派生重算红利」前提被本改造修正,故 **本改造是 checkpoint 腿的真正前置**。编排:reach/endurance 与 Wave 0-2 并行起跑;checkpoint 腿 gated 在本改造后;artifact(Wave 3)与 YUK-358 合流。

---

## 6. ADR-0041 修正点

**裁定:不推翻,劈成两半改写。** ADR-0041 checkpoint 腿原假设「系统已 event-sourced → 撤事件即派生自动重算(纯红利)」。本改造证伪了**前提的一半**:

| ADR-0041 原措辞 | 真相 | 修正后措辞 |
|---|---|---|
| 「派生重算红利」(撤 PR-N → 所有派生态自动重算,ADR-0006 红利) | **结构半边成立**(fold 重算确实自动);**θ̂/FSRS 半边不成立**(命令式覆盖写,撤事件纹丝不动,必须快照恢复) | 改为「**event-sourced 重算 + 快照混合**:结构性派生(知识树/边/artifact/structured/mistake/goal/learning_item)走 fold 重算自动复原(ADR-0006 红利成立);θ̂(mastery_state)/FSRS(material_fsrs_state)走 before/after 快照恢复(非重算),revert=恢复快照 + 级联倒带」 |
| 「撤早期 PR 级联,按 caused_by 反依赖序追加补偿」(假定遍历器存在) | 现有 `getEventChain` **只单跳**,recursive CTE **仓库从未落地** | 补一句「级联遍历器(recursive CTE + cycle guard + depth limit)是本腿硬前置,YUK-363 Wave 0 引入(`src/server/events/cascade.ts`),非既有能力」 |
| 「durable run partial 留 live + partial PR 进 keep/revert」 | worker `ctx.causedByEventId` **half-wired**(ADR-0041:55 已自认),脱链会让级联漏收 | 强化为「worker 进程 `ctx.causedByEventId` 透传是级联正确性的**头号硬前置**(优先级高于 `propose_*` rename),YUK-363 Wave 0 落地」 |
| 隐含假设:级联 revert 对所有下游对称 | θ̂/FSRS 不可「抽掉中间保留后续」(需重放,owner 否决),且触及已练 attempt 不可逆 | 补「**诚实天花板**:per-utterance 窗口内(刚说完未练)级联几乎总干净;跨 turn 撤旧 PR 触及已练 attempt/已入册 FSRS 时**部分不可逆**,遍历器 `reversibility` 标记如实展示,触及 irreversible 整体拒绝 + 告知边界」 |

---

## 7. 诚实天花板:哪些下游 revert 撤不掉

下游分三类(对应 ADR-0041「approve-before → revert-after」窗口):

| 类别 | 例子 | 可撤? | 机制 |
|---|---|---|---|
| **纯派生 projection** | 知识树节点/边、mastery view、错题队列、artifact 内容、structured 树 | ✅ 干净撤 | 追加 retract/restore,读路径派生自动重算(§3.3.5) |
| **实体行(带乐观锁)** | artifact row、knowledge 节点、practice_stream_item 排入 | ✅ 软删 | `archived_at` 软删(artifact 有此列 `schema.ts:344`);practice_stream_item 标 skipped/删行;冲突走 409 |
| **既成事实(不可撤)** | 真 **attempt** 事件、**review** 事件 + FSRS 入册、用户已 `user_verified` 块 | ❌ 撤不掉 | attempt/review 是**用户真发生的行为事实**,retract 它 = 篡改历史 |

**精确边界**:
- **题进 frontier(practice_stream_item 排入)= 可撤**(用户还没练,只被排进来)。
- **真 attempt/review 已发生 = 不可撤**。撤 PR-N 时若级联触及已被 attempt/review 引用的下游,遍历器**停下告知**:「PR-N 的下游 X 已产生真实练习 attempt(事件 e_NNN),无法干净级联撤销」。
- **FSRS 入册/θ̂ = 快照恢复路径**,但 §0 事实 B 的语义裂口在此咬合:快照只能**倒带到 attempt 之前**,不能「抽掉中间一次保留后续」。所以**跨 turn 撤一个中间 attempt 时,其后所有同 subject attempt 必须一并级联 retract(倒带式),否则就是不可逆**。owner 否决了重放,故这是诚实代价而非 bug。
- **per-utterance 窗口的诚实表述**:turn 内(刚说完、未练)级联几乎总干净(下游全是 projection + 实体行);**窗口越久,不可逆下游越多**。这是 ADR-0041 checkpoint 腿的内在物理边界,不是实现缺陷。

---

## Linear

**无需新建 issue。** 本任务是 YUK-363(已立项 2026-06-15,High,parent YUK-203)「深度 design workflow(勘察 4 硬问题)→ cross-统合改造设计 → ADR 化」流程中的统合 pass,本草案是其设计输出,应归档进 YUK-363(贴评论或转 ADR-0042)。四路勘察一致确认无孤立 follow-up 需新开票:级联遍历器、caused_by 补全、worker half-wired gap、`propose_*` rename 均已在 ADR-0041:55/56/61 + `2026-06-15-copilot-agentic-checkpoint-draft-layer.md:58-62` 登记待批量建票(承 YUK-203)。配套已有票:YUK-355(mem0 备份)、YUK-333(question_edit retract 静默 no-op,同类不可逆 bug)。

**唯一提请 owner 注意的优先级裁定**(建议在 YUK-363 拆子任务时显式标):worker 进程 `ctx.causedByEventId` 透传(§3.4 头号项)是级联 revert 正确性的硬前置,优先级应**高于** `propose_*` rename —— durable run 脱链会让整个级联机制漏收下游,是地基级阻断。

---

## 设计文件落点建议(供 ADR-0042 + 实施引用)

- 重算引擎核心(纯函数):`src/core/projections/<table>.ts`(蓝本 `corrections.ts:41-106`)
- 重算引擎 IO 壳:`src/server/projections/<table>.ts`(物化模式 `fsrs/state.ts:36-58`)
- 全量重放兜底:`scripts/rebuild-projection.ts`(新)
- 快照写器:`src/server/mastery/` + `src/server/fsrs/`(守单写者,新增 `deleteMasteryState`/`deleteFsrsState`)
- 级联遍历器:`src/server/events/cascade.ts`(新,仓库首个 `WITH RECURSIVE`,蓝本 `queries.ts:943-977`)
- 级联编排器:`src/server/revert/cascade-revert.ts`(新,补偿写法复用 `event-correct.ts:63-74`)
- drift lint:`pnpm audit:projection`(新,接 CLAUDE.md audit 家族)
- ADR:新建 ADR-0042(本草案)+ 修正 ADR-0041 §checkpoint 腿(§6 四点)


---

# 第二部分 · 4 路深挖原始（追溯）



## §A 重算引擎

I now have a complete, evidence-grounded picture of all four structural projections, their write points, event-trail completeness, and the existing fold precedents. I have everything needed to write the design draft.

The key finding crystallizes: the `block.structured_edited` events (written to `job_events`, not the canonical `event` table) carry only `{ op, node_id }` — they record *that* an edit happened, not *what* the new value is. They are pure audit breadcrumbs, NOT replayable. This is the single largest payload gap. The same is true for `experimental:artifact_body_blocks_edit` and `runNoteGenerate` (no event at all).

Below is the design draft.

---

# Event 流 → Projection 重算引擎 — 设计草案

## 0. 一句话结论

四张结构性 projection 当前**写法不一**(从「事件即真相、payload 自足」到「无事件、纯命令式」横跨整个光谱)。要做到「事件唯一真相、结构性写走真重算」,真正的工作量不在重算引擎本身(已有 `getCorrectionStatuses` / `effective-truth.ts` 两个成熟 fold 范式可推广),而在**补齐 event payload 让每个结构突变自足可重放** + **把 `question_block.structured` / `artifact` 的写从 `job_events` / 无事件迁回 canonical `event` 表**。

---

## 1. 现状:四个结构性 projection 的命令式写点 + 事件留痕

| Projection | 物化形态 | 主写点 (file:line) | 写什么 | 当前事件留痕 | 重放自足? |
|---|---|---|---|---|---|
| **knowledge** (节点树) | 物化表 | `applyProposeNew/Reparent/Archive/Split/Merge` `src/capabilities/knowledge/server/proposals.ts:246-414`;经 `acceptProposal` `:486-624` 在 tx 内调用 | INSERT/UPDATE `knowledge` 行 (parent_id / archived_at / merged_from / version) | `propose` event (ProposeKnowledge) 或 `experimental:knowledge_{reparent,merge,split,archive}` (ProposeKnowledgeEdge 同表),accept 时追一条 `rate`(accept) chained via `caused_by_event_id` | **基本自足**。propose payload 携带 `{name,parent_id}` 或 reparent/merge/split 全字段(`acceptProposal:504-514` 已证明能从 event payload 重建 mutation body) |
| **knowledge_edge** | 物化表 | `decideKnowledgeEdgeProposal` `src/server/proposals/actions.ts:229-539` | INSERT `knowledge_edge` (create) 或 `archiveKnowledgeEdge` set archived_at | tx 内写 `rate`(accept/reverse/change_type/dismiss) + `generate`(GenerateKnowledgeEdge,payload 含 `from/to/relation_type/weight/reasoning/edge_op`) | **自足**。`generate` event payload 已是 edge 的完整快照;archive 经 `edge_op:'archive'` + `archive_edge_id` |
| **artifact** | 物化表 | (a) 创建:`learning_intent.ts` / `tool-quiz-core.ts` / `author-artifact.ts:83-139` / `make-paper.ts`;(b) body 重写:`runNoteGenerate` `src/capabilities/notes/jobs/note_generate.ts:130-245`;(c) block 编辑:`editArtifactBodyBlocks` `body-blocks-edit.ts:29-119` + `persistNoteRefineApply` `note-refine-apply.ts:94-200` + `sections.ts` | INSERT/UPDATE `artifact` (body_blocks / attrs / history / version / generation_status) | **极度碎裂**: `note_refine_apply` 写 canonical event 且 payload **完整**(`ops` + `previous_body_blocks` + `reverse_patch`,`:161`);`body_blocks_edit` 写 canonical event 但 payload **只有 version 号**(`:101-105`);`runNoteGenerate` / `author-artifact` **完全不写 event**(靠 pg-boss / copilot bridge mirror);`sections.ts` 写 `experimental:artifact_section_edit` | **大部分不自足** ⚠️ |
| **question_block.structured** | 物化表 (JSONB 原地改) | `updatePrompt/addOption/setQuestionType/splitStem/mergeQuestions/reassignFigure` `src/capabilities/ingestion/server/block-structured-edit.ts`,统一经 `persistStructured` `:122-149` | UPDATE `question_block.structured` (整树替换) + figures + version | **写到 `job_events` 表,不是 canonical `event`**。`writeJobEvent` `src/server/events/writer.ts:21-45`,payload **只有 `{op, node_id}`**(`persistStructured:144-148`) — 记录「发生了 update_prompt」但不记录「改成了什么」 | **完全不自足** ⚠️⚠️ |

### 现状两条成熟的 fold 范式 (重算引擎应直接推广这两个,而非从零造)

- `getCorrectionStatuses` `src/server/events/corrections.ts:41-106`:典型 reducer — `ORDER BY created_at, id` 拉同 subject 的 `correct` events,`switch(correction_kind)` 累积出 `{active|retracted|marked_wrong|superseded}` 终态。
- `getEffectiveTruth` / `cycleEffectiveTruth` `src/capabilities/practice/server/effective-truth.ts`:对一个 subject 的事件序列做状态机 step。

这俩就是「fold(events) → projection」的现成模板,只是目前各自只 fold 出一个**状态标签**,没 fold 出**完整业务行**。

---

## 2. Event payload 自足性审计 + 补字段清单

事件唯一真相的前提:`fold(events for subject)` 必须能**不读 projection 表**重建整行。逐表审计:

### 2.1 knowledge — 基本自足,补 2 个洞

- ✅ propose_new / reparent / archive / merge / split 的 mutation body 全在 payload(`acceptProposal:504-514` 反序列化已证明)。
- ❌ **缺洞 1 — accept 与 mutation 解耦**: 实际改表的 `rate`(accept) event payload 只有 `{rating:'accept'}`(`proposals.ts:589`),mutation detail 在被它 `caused_by_event_id` 指向的 propose event 里。重算 reducer 必须做 **join**(rate → 找 propose → 读 mutation)。可行但 reducer 需要两跳。
  - **补字段**: `RateEvent.payload` 可选加 `applied_mutation_snapshot`(accept 时把最终生效的 mutation body inline,免 join)。或保持 join(成本可接受,因为 propose event 同表)。**建议保持 join,不补** — 链已存在。
- ❌ **缺洞 2 — `applyProposeNew` 生成的 new_node_id 不在任何 event**: `applyProposeNew:253` `newId()` 当场生成节点 id 并 INSERT,但这个 id **没回写进 propose 或 rate event payload**。重放时无法确定性地复现同一个 id → 重算会生成**不同的 knowledge.id**,引用它的所有 edge / artifact.knowledge_ids 全断。
  - **补字段(P0,硬阻断)**: accept 路径必须把 `created_node_id`(及 split 的 `created_node_ids[]`)写进 `rate`(accept) event payload。`RateEvent.payload` 加 `materialized_ids: string[]`。这是把命令式 id 生成「钉进事件流」的关键。

### 2.2 knowledge_edge — 完全自足,补 1 个洞

- ✅ `generate` event payload 是 edge 的完整快照(`actions.ts:483-499`),archive 经 `edge_op`。
- ❌ **缺洞 — edge.id 同样当场 `createId()`**(`actions.ts:480`),只在 `generate` event 的 `subject_id` 里(✅ 这个其实在),但 create-by-user 直接落库的旁路要核。
  - **补字段**: 无新字段。`generate.subject_id === edge.id` 已成立,reducer 用 subject_id 当 PK 即可。**确认通过**。

### 2.3 artifact — 最大工程量

- ✅ `note_refine_apply` 自足(`ops` + `previous_body_blocks` + `reverse_patch`)。
- ❌ **缺洞 1 — `body_blocks_edit` payload 只有 version 号**(`body-blocks-edit.ts:101-105`),不含新 `body_blocks`。重算无法重建。
  - **补字段(P0)**: payload 加 `body_blocks`(新全量树)或 `ops`(patch)。建议存全量 `body_blocks` 快照(artifact 体量可控,全量快照最稳)。
- ❌ **缺洞 2 — `runNoteGenerate` 不写 event**(`note_generate.ts:213-228` 只 UPDATE artifact)。AI 生成正文这一步**完全没进事件流**。
  - **补字段(P0)**: `runNoteGenerate` 成功后在同 tx 写 `GenerateArtifact` event(`action:'generate',subject_kind:'artifact'`),payload 现仅 `{artifact_kind,title,body_md}` — 需扩展为 `body_blocks`(现 schema 是 `body_md:string`,note 用的是 `body_blocks` 结构树,**`GenerateArtifact.payload` 要加 `body_blocks?: ArtifactBodyBlocks`**)。`known.ts:193-198`。
- ❌ **缺洞 3 — artifact 创建散在 5 处,事件 action 不统一**: `author-artifact` 靠 copilot bridge mirror(`author-artifact.ts:144` `mirrorEvent:'when_causal'`)、`note_generate` 用 `note_generate` action(非 KnownEvent,见 `appeal.db.test.ts:100`)、`tool-quiz-core` / `learning_intent` / `make-paper` 各自写。创建事件的 `action`/`payload` 没有统一契约。
  - **补字段(P0)**: 所有 artifact 创建归一到 `GenerateArtifact` event(或新增一个 `create` artifact event),payload 必须含 row 重建所需的全部不可派生列:`type, title, intent_source, source, parent_artifact_id, knowledge_ids, tool_kind, attrs`(现 `GenerateArtifact.payload` 全缺这些)。
- ❌ **缺洞 4 — attrs / generation_status / verification_status 的转移无事件**: `note_verify` 改 `verification_status`、`generation_status:'failed'` 兜底(`note_generate.ts:235`)等状态机转移没有对应 event。
  - **补字段(P1)**: 这些是「生命周期状态」,可选纳入(owner 拍板「全部 projection 表纳入」→ 应纳入)。加 `experimental:artifact_status` 或扩 GenerateArtifact outcome。

### 2.4 question_block.structured — 需整体迁移事件层

- ❌ **缺洞 1(根因)— 写的是 `job_events` 不是 `event`**: `persistStructured:142` 调 `writeJobEvent`。`job_events` 不在 KnownEvent union、不进 outbox、不被任何重算覆盖。
  - **改造(P0)**: structured 编辑改写 canonical `event`,新增 KnownEvent `EditQuestionBlockStructured`(`action:'edit'`(新)或 `experimental:block_structured_edited`,`subject_kind:'question_block'`(新增 subject_kind))。
- ❌ **缺洞 2 — payload 只有 `{op,node_id}`**,不含编辑后的值(prompt_text / option / 新 structured 树)。`persistStructured:144`、`splitStem:387`、`mergeQuestions:524`。
  - **补字段(P0)**: payload 必须含重放该 op 所需全部输入:`update_prompt → {node_id, prompt_text}`、`add_option → {node_id, option}`、`set_question_type → {node_id, kind}`、`split_stem → {node_id}`(纯结构,可派生)、`reassign_figure → {asset_id, target_node_id}`、`merge_questions → {merged_from_block_ids, ...}`。最稳:存编辑**后的全量 `structured` 快照**(每个 block 一棵树,体量小)。
- ❌ **缺洞 3 — `subject_kind` 缺 `question_block`**: `event.subject_kind` 枚举(schema.ts 注释 `:609`)无 `question_block`。
  - **补字段(P0)**: KnownEvent 加 `subject_kind:'question_block'` 分支;`computeAffectedScopes` / mastery view 不受影响。

### 补字段清单汇总(按优先级)

| # | 优先级 | 位置 (file:line) | 补什么 | 原因 |
|---|---|---|---|---|
| 1 | P0 | `RateEvent.payload` `known.ts:215-218` | `materialized_ids?: string[]` | knowledge 节点 id 当场生成无留痕,重放 id 漂移 |
| 2 | P0 | `body-blocks-edit.ts:101-105` | payload 加 `body_blocks`(全量) | body_blocks_edit 不可重放 |
| 3 | P0 | `note_generate.ts:213-228` | 同 tx 写 GenerateArtifact event | AI 生成正文不进事件流 |
| 4 | P0 | `GenerateArtifact.payload` `known.ts:193-198` | 加 `body_blocks?`, `type`, `intent_source`, `source`, `parent_artifact_id`, `knowledge_ids`, `tool_kind`, `attrs` | 创建事件不足以重建 artifact 行 |
| 5 | P0 | 新 `EditQuestionBlockStructured` KnownEvent | `subject_kind:'question_block'` + 编辑后 structured 快照 | structured 编辑写 job_events 且 payload 不含值 |
| 6 | P0 | `block-structured-edit.ts:142` | `writeJobEvent` → `writeEvent`(canonical) | job_events 不在事件真相层 |
| 7 | P1 | artifact 生命周期状态转移 | `experimental:artifact_status` event | generation/verification status 转移无事件 |

---

## 3. 重算引擎形态:reducer 模式

### 3.1 总形态 — 每表一个纯函数 reducer,放 `core/`,签名统一

```
fold: (events: KnownEventT[], opts) => ProjectionRow[]   // 纯函数,无 IO
```

放 `src/core/projections/<table>.ts`(纯函数,无 IO,与 `getCorrectionStatuses` 的状态机逻辑同构但产出整行)。**理由**: 重算逻辑必须可单测、可在 worker / API / 迁移脚本三处复用、不依赖 db client。这与项目「`core/` cross-subject no-IO」分层(CLAUDE.md)一致。

server 侧 `src/server/projections/<table>.ts` 负责 **IO 包壳**:拉事件 → 调 core reducer → 写回 projection 表(materialize)或返回(派生读)。

### 3.2 每表 reducer 需求

| 表 | reducer 输入事件 (按 `created_at,id` 排序) | 累积逻辑 | 输出 |
|---|---|---|---|
| **knowledge** | `propose`+`rate`(同 subject 链)、`experimental:knowledge_{reparent,merge,split,archive}` | 起始空;propose+rate(accept)→ INSERT 行(用补字段 #1 的 materialized_ids 锚 id);reparent → set parent_id;archive → set archived_at;merge → set merged_from + archive from_ids;split → archive + INSERT children | `knowledge[]` |
| **knowledge_edge** | `generate`(subject=edge_id)、`rate`(edge,`edge_op:archive`) | generate(create)→ upsert edge 行(subject_id=PK);generate(archive)→ set archived_at | `knowledge_edge[]` |
| **artifact** | `generate`(create,补字段 #4)、`body_blocks_edit`(补 #2)、`note_refine_apply`、`section_edit`、生命周期 status(补 #7) | create → INSERT;每个 edit → 取 payload 全量 body_blocks(或 apply ops over reverse-derivable prev),bump version + 追 history | `artifact[]` |
| **question_block.structured** | 新 `EditQuestionBlockStructured`(补 #5/#6) | 起始 = OCR extract 时的 structured;每个 edit op → 取 payload 快照替换树 | `question_block` 的 structured/figures/version/status |

**注意 merge/split 跨实体**:knowledge merge 同时 touch into_id(set merged_from)+ from_ids(archive),artifact merge_questions 同时 touch primary + N 个 merge blocks。reducer 必须以**整批 events 为单位**而非「per-entity 独立 fold」,否则跨实体一致性断(一个 merge 事件影响多行)。

### 3.3 增量 vs 全量

**默认增量重算(单实体级),全量重放仅作 audit/迁移兜底。**

- **增量**:每次写事件后,只重算「受该事件影响的实体集合」(从 event 的 `subject_id` + payload 内引用的 id 推导,如 merge 的 from_ids/into_id)。复用 `event_subject_idx`(`schema.ts`,`(subject_kind, subject_id, created_at)`)拉该实体全历史 → fold → 写回。
- **全量重放**:一个 `scripts/rebuild-projection.ts` 兜底命令,truncate projection + 全量 fold,用于:(a) 补字段后的一次性 backfill;(b) drift audit(重算结果 vs 现表 diff,接 `pnpm audit:schema` / `/audit-drift` 家族);(c) 灾难恢复。
- **理由**:全量 fold 每次写都跑不现实(event 表会无限长);但纯增量易累积漂移,所以全量重放当**对账真相**而非热路径。

---

## 4. 物化策略:写回 projection 表(materialized),不做纯派生

**结论:四张表全部 materialized(重算结果写回表),不做读时 fold。**

- 现状已是两种范式并存:`knowledge_mastery` 是 SQL view(纯派生,`drizzle/0005:CREATE VIEW`),`material_fsrs_state` 是物化(`upsertFsrsState` onConflictDoUpdate,`src/server/fsrs/state.ts:36-58`),`mastery_state`(B1-W1,`schema.ts:701`)也是物化取代 view。**项目趋势是从 view 走向物化**(ADR-0035 注释明说 mastery_state 取代 view)。
- 结构性 projection(knowledge 树/edge 图/artifact 正文/structured 树)是**高频读、复杂结构、被大量 join 引用**(edge FK → knowledge.id;artifact.knowledge_ids;due-list/mastery 都读 knowledge)。读时 fold 会让每次 KG 渲染重放全历史 — 不可接受。
- **范式选择**:materialized,write-through。重算引擎产出的行经 upsert 写回(同 `upsertFsrsState` 模式)。projection 表降级为「事件流的缓存/快取」,真相在 event。
- view 范式(`knowledge_mastery`)留给**纯统计派生维**(mastery/活跃度),它本就无 id 锚、无外部引用,view 即可;不纳入本重算引擎。

---

## 5. 一致性:写事件 = 改 projection 原子

### 5.1 现状不一致风险(实证)

- `runNoteGenerate`(`note_generate.ts:213`)改 artifact 但**不写 event** → 写了表没写事件。
- `persistStructured`(`block-structured-edit.ts:122`)写 `job_events` 不写 `event` → canonical 事件流缺这笔。
- `author-artifact`(`author-artifact.ts:83`)依赖 copilot bridge 的 `mirrorEvent:'when_causal'` 异步补事件 → 非 tx 内,bridge 不 fire 就写了表没事件。
- 反向(写事件没改表)目前少见,因命令式写在前。

### 5.2 改造后的原子契约

**单一写入闸:`applyStructuralMutation(tx, event)`。** 任何结构性写都不再直接 `tx.update(table)`,而是:

```
applyStructuralMutation(tx, eventInput):
  1. writeEvent(tx, eventInput)            // 先写事件(真相)
  2. const affected = deriveAffectedIds(eventInput)
  3. for id in affected:
       rows = pull all events for (subject_kind, id)  // 含刚写的
       projectionRow = coreReducer(rows)
       upsert(tx, table, projectionRow)    // 重算写回,同 tx
```

- **同 tx**:`writeEvent` + reducer apply + upsert 三步在一个 `db.transaction`。rollback 则事件和投影一起消失(与现有 `acceptProposal:495` / `decideKnowledgeEdgeProposal:441` / `persistNoteRefineApply` 的 tx 边界一致,只是把「命令式 set」换成「reducer 重算 set」)。
- **outbox 不变**:`writeEvent` 已是 INSERT-only + outbox(`schema.ts ingest_at`,ADR-0021),memory ingest 仍走 poll,与本改造正交。
- **乐观锁保留**:reducer 算出的 `version` 仍走 `WHERE version = expected` 守门(现有 `applyReparent:286` / `body-blocks-edit:80` 模式),防并发双写。
- **audit lint**:新增 `pnpm audit:projection`(仿 `audit:schema`):对每张结构性表跑全量 fold,diff 重算结果 vs 现表,非空 diff = drift,fail。这是「事件=真相」的机器守门,接 CLAUDE.md 的 audit 家族。

### 5.3 迁移顺序(避免 big-bang)

1. **补 payload(P0 #1-#6)**:让事件先变自足,旧写点照旧(双写期)。
2. **影子重算**:写 core reducer + `audit:projection` 只读对账,跑出现有不一致清单(预期 `note_generate` / `structured` 大面积 drift,因事件本就缺)。
3. **逐表切写闸**:knowledge_edge(最自足)→ knowledge → artifact → question_block.structured(最重)。每表把命令式写换成 `applyStructuralMutation`。
4. **删 `job_events` 结构编辑分支**(P0 #6 落地后)。

---

## 6. 关键 file:line 索引

- Event schema(KnownEvent union + 全 payload):`src/core/schema/event/known.ts:1-589`;escape hatch `src/core/schema/event/experimental.ts:134-146`
- Event 表:`src/db/schema.ts:597`(`event`),subject_kind 枚举注释 `:609`
- writeEvent(唯一事件写入闸 + parse barrier + outbox):`src/server/events/queries.ts:1019-1071`
- knowledge 写点:`src/capabilities/knowledge/server/proposals.ts:246-414`(appliers),`:486-624`(acceptProposal tx),id 生成漏留痕 `:253`,event 反序列化重建 mutation `:504-514`
- knowledge_edge 写点:`src/server/proposals/actions.ts:229-539`(create/archive),edge.id 生成 `:480`,generate payload 快照 `:483-499`
- artifact 写点:创建 `src/server/ai/tools/author-artifact.ts:83-139`(无 event,靠 mirror `:144`);正文生成 `src/capabilities/notes/jobs/note_generate.ts:130-245`(**无 event** `:213-228`);block 编辑 `src/capabilities/notes/server/body-blocks-edit.ts:29-119`(event payload 缺 body `:101-105`);patch 编辑 `src/capabilities/notes/server/note-refine-apply.ts:94-200`(**唯一自足**,reverse_patch `:161`)
- question_block.structured 写点:`src/capabilities/ingestion/server/block-structured-edit.ts:122-149`(persistStructured),`:161-180`(updatePrompt),`:356-392`(splitStem),`:411-536`(mergeQuestions);写 job_events 非 event `:142`
- job_events 写入:`src/server/events/writer.ts:21-45`(writeJobEvent)
- **现成 fold 范式**(reducer 蓝本):`src/server/events/corrections.ts:41-106`(getCorrectionStatuses,ORDER BY created_at,id + switch 累积);`src/capabilities/practice/server/effective-truth.ts`(状态机 step)
- 物化范式参考:`src/server/fsrs/state.ts:36-58`(upsertFsrsState,onConflictDoUpdate write-through)
- 派生范式参考(不纳入重算):`drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`(CREATE VIEW knowledge_mastery)
- 物化表 schema:`src/db/schema.ts:50`(knowledge),`:102`(question_block),`:325`(artifact),`:679`(material_fsrs_state),`:701`(mastery_state),`:791`(knowledge_edge),`:909`(knowledge_mastery view)

---

## 7. Linear issue 捕获

本任务为只读勘察 + 设计草案,未实施代码改动。设计本身揭示了若干**已存在的事件流不一致(技术债)**值得开 issue 跟踪,但按指令我不主动创建 — 交由 owner 决定立项。建议的 follow-up issues(若立项):
1. **P0** `runNoteGenerate` / `author-artifact` 创建 artifact 不写 canonical event(事件流真相缺口,非重算引擎引入)。
2. **P0** `question_block.structured` 编辑写 `job_events` 而非 `event`,且 payload 不含编辑后值(`block-structured-edit.ts:142`)。
3. **P1** `body_blocks_edit` event payload 不含 body_blocks,不可重放(`body-blocks-edit.ts:101`)。
4. **Epic** 「event 流 → projection 重算引擎」(本草案,含补字段 #1-#7 + reducer + `audit:projection` + 迁移四步)。

无需我为本勘察任务本身另开 issue。


## §B 快照可逆

YUK-363 is the exact umbrella for this work, already covering scope (snapshot reversibility, structural fold recompute, cascade revert, caused_by recursive CTE). No new Linear issue is needed — this investigation is the "深度 design workflow → 勘察 4 硬问题" pass that YUK-363's 流程 section calls for. My findings can feed directly into that issue's design. I have all the grounding I need now.

Here is the deep investigation report.

---

# θ̂/FSRS 快照可逆机制 — 深度勘察

## 0. 关键发现先行 + 与 owner 拍板对账

**勘察证实了不可逆的根因**：θ̂/FSRS 是命令式覆盖写的物化投影，而 `event` 表是审计痕迹而非真相源。证据链：

- `event-correct.ts:63` 的通用 `correct` 路由只 `writeEvent(CorrectEvent)`，**完全不碰** `mastery_state` / `material_fsrs_state`。`retract` 一条 review/attempt event 后，θ̂ 和 FSRS Card 纹丝不动 —— 这正是 YUK-363 描述的「撤 event 行 projection 纹丝不动」。
- `corrections.ts` / `effective-truth.ts` 只在**读时**把 retracted/superseded 行过滤掉（`getCorrectionStatuses` → `getEffectiveTruths`）。但 θ̂/FSRS 不经这个读层 —— 它们是直接 `SELECT` 物化行，没有「重算」入口。
- θ̂ 更新路径依赖（`mastery/state.ts:211-222`）：`newTheta = s.theta + eloK(s.evidence) · bWeight · credits[i]`。`eloK` 看 `evidence_count`、`credits` 看当前 `theta_hat` 经 `expectedScore`。**新值是旧值的函数** → 全序列重放才能精确还原，单点不可逆。这就是 owner 选快照而非重放的数学理由。

**与 owner 拍板完全一致**（YUK-363 已立项，无需新建 issue）：保留命令式在线更新，旁路 append before/after 快照 event，revert = 恢复快照。下面是落地设计。

**重要勘察修正**：prompt 给的 file:line（`mastery/state.ts:214 conjunctiveCredits` / `submit.ts:494-592`）与实际有偏差。真实坐标：
- `conjunctiveCredits` 定义在 `src/core/theta.ts:90`，在 `src/server/mastery/state.ts:204` 被调用；θ̂ 覆盖写在 `state.ts:211-223`。
- attempt→event tx 在 `src/capabilities/practice/api/submit.ts:373-600`（`persistSubmit` 内的 `db.transaction`），`writeEvent(attempt/review)` 在 `:494`，`writeEvent(judge)` 在 `:545`，`upsertFsrsState` 在 `:577`，`updateThetaForAttempt` 在 `:592`。
- paper 路径同构于 `src/capabilities/practice/server/paper-submit.ts:501-598`。

---

## 1. 快照 event 如何 append（问题①）

### 推荐：**新增独立 snapshot event 类型**，不扩 attempt/review payload

三个理由压倒「扩 attempt payload」方案：

1. **多 KC 一次 attempt 更新多个 θ̂ 行 + 一个 FSRS 行**（`submit.ts:592` 传 `q.knowledge_ids` 全集给 `updateThetaForAttempt`，但 FSRS 只更 `fsrsSubjectIds = requested∩labels` 子集 —— 见 `submit.ts:348-355`、`state.ts:147` vs `:592` 注释）。一条 attempt 的快照天然是「N 个 θ̂ + M 个 FSRS」的集合，塞进 attempt payload 会让 `AttemptOnQuestion` / `ReviewOnQuestion` schema 膨胀且与「答案内容」职责混淆。
2. **单写者红线**（`step9-invariant-audit.test.ts:170-178`）：`mastery_state` 唯一写者必须在 `src/server/mastery/`，`material_fsrs_state` 必须在 `src/server/fsrs/`。快照内容由这两个模块产出最自然 —— 让快照 event 由各自的单写者模块 emit，而非由 `submit.ts` 拼装 attempt payload，职责对齐。
3. **已有精确先例**：`proposal-appliers.ts:668` 的 `experimental:question_structure_edit` 就是「独立 event 带 `before`/`after` snapshot 作为可逆记录」的活模式（结构编辑）。θ̂/FSRS 快照照抄此形态即可，是项目既有惯例而非新发明。

### 落地形态：经 experimental escape hatch，单条聚合快照 event

新增一个 action `experimental:state_snapshot`（或拆 `experimental:theta_snapshot` + `experimental:fsrs_snapshot`，见下），`subject_kind='event'`、`subject_id = attemptEventId`、`caused_by_event_id = attemptEventId`。它走 `experimental.ts:134` 的通用 `ExperimentalEvent` fallback（**不**进 `RESERVED_EXPERIMENTAL_ACTIONS`，否则要写专用 Zod），与 `question_structure_edit` 同一条松守路径。`writeEvent`（`queries.ts:1020`）的 `parseEvent` 对 experimental action 只校验 `payload` 是 record，shape 由业务层守。

**单 attempt 单快照 event**（而非每 KC 一条）：一条快照 event 的 payload 内含一个 `theta_snapshots[]` 数组（N 个 KC）+ 一个 `fsrs_snapshots[]` 数组（M 个 subject）。理由：①一次 attempt 是一个原子 revert 单元，多条 event 反而要重新聚合；②存储更省（一个 envelope vs N+M 个）；③与 attempt event 同 tx 写入，`caused_by` 单跳即可找到。

**写入位置**（守单写者）：
- `updateThetaForAttempt`（`state.ts:143`）在循环里已经持有每个 KC 的 `s.theta`（before）和算出 `newTheta`（after），**就地收集** before/after，函数返回 `ThetaSnapshotEntry[]`。
- `upsertFsrsState`（`fsrs/state.ts:37`）调用方（`submit.ts:389-431` 已经持有 `prevStateRow.state`（before）和 `update.stateAfter`（after））—— 让 FSRS 单写者模块暴露一个 `collectFsrsSnapshot()` 或直接让调用方收集（FSRS before/after 已在手）。
- 然后在同 tx 内由 `submit.ts` / `paper-submit.ts` 调一个新的快照写入器（放 `src/server/mastery/` 或新建 `src/server/state-snapshot/`，但**写 event 表本身**经 `writeEvent` 合法，无单写者约束）emit 这条聚合快照 event。

同 tx 关键（守 hermetic + 原子性，呼应 `submit.ts:592` 注释「写独立 mastery_state 表，不碰 event/learning_record count——hermetic 不破」）：attempt event + judge event + FSRS upsert + θ̂ update + **快照 event** 五者同一 `db.transaction`，回滚则全无。

---

## 2. 快照 payload schema（问题②）

```ts
// experimental:state_snapshot — subject_kind='event', subject_id=attemptEventId,
// caused_by_event_id=attemptEventId. 经 ExperimentalEvent 松守 fallback（不进
// RESERVED set），与 question_structure_edit 同路径。
{
  attempt_event_id: string,          // = subject_id，冗余便于查询
  source: 'review_submit' | 'paper_submit',  // 哪条写路径产出（审计 + revert 路由）

  theta_snapshots: Array<{
    knowledge_id: string,            // = mastery_state.subject_id (subject_kind 恒 'knowledge')
    // before：cold-start 时整个行不存在 → before=null 表「revert 应删行」
    before: null | {
      theta_hat: number,
      evidence_count: number,
      success_count: number,
      fail_count: number,
      last_outcome_at: string | null,  // ISO
    },
    after: {                         // after 永远非空（这次 attempt 一定写了行）
      theta_hat: number,
      evidence_count: number,
      success_count: number,
      fail_count: number,
      last_outcome_at: string,
    },
  }>,

  fsrs_snapshots: Array<{
    subject_kind: 'knowledge' | 'question',  // = material_fsrs_state.subject_kind
    subject_id: string,
    before: null | {                 // cold-start：行不存在 → null → revert 删行
      state: FsrsStateSchemaT,        // ts-fsrs Card dump（与 known.ts:117 ReviewOnQuestion 同 schema）
      due_at: string,                 // ISO
      last_review_event_id: string | null,
    },
    after: {
      state: FsrsStateSchemaT,
      due_at: string,
      last_review_event_id: string,
    },
  }>,
}
```

**设计要点**：
- **`before: null` = cold-start 哨兵**。这是 revert 正确性的核心：首次 attempt 时 `mastery_state` / `material_fsrs_state` 行不存在（`state.ts:190-199` 的 `byId.get(id) ?? 0` 冷启、`fsrs/state.ts:88` 返回 null）。revert 时 before=null 必须**删行**而非 upsert，否则会留下伪造的 0-evidence 行。
- **不存 `b` 锚 / `credit` / `k`**：这些是中间量，revert 不需要（恢复 after→before 是纯状态替换，不重算）。但**可选**存 `attempt_outcome` + `b_used` 作为审计/调试痕迹（便于事后核对快照是否 self-consistent），非 revert 必需。
- **FSRS before/after 直接是 `FsrsStateSchemaT`**（`core/schema/event/blocks.ts`，与 review event 的 `fsrs_state_after` 复用）—— 不引入新 schema，与既有 `fsrs_state_after_by_subject`（`submit.ts:508`）形态一致。注意 review event payload 里**已经**有 `fsrs_state_after`（after 半边），但**没有 before** 也没有 mastery —— 所以快照不是冗余，它补的是 before 半边 + θ̂ 全部。

**拆分 vs 聚合的二选一**：若 owner 偏好 per-axis 拆开（`experimental:theta_snapshot` + `experimental:fsrs_snapshot` 两条），好处是 θ̂ 改造和 FSRS 改造可分 wave 落地、revert 器可独立测；代价是一次 attempt 多一条 event 行 + revert 要查两 action。**推荐聚合单条**（attempt 是原子 revert 单元），但这是 owner 可拍的形态选择。

---

## 3. Revert 恢复机制 + 级联（问题③）

### 单点恢复 = 补偿 event + 命令式写回 before

恢复一个快照的动作（放 `src/server/mastery/` + `src/server/fsrs/`，守单写者）：
1. 读 `experimental:state_snapshot` event 的 payload。
2. 对每个 `theta_snapshots[i]`：
   - `before !== null` → `upsertMasteryState(tx, {...before})`（`state.ts:52` 既有 upsert，命令式写回）。
   - `before === null` → `DELETE FROM mastery_state WHERE subject_kind='knowledge' AND subject_id=...`（需在 `src/server/mastery/` 加一个 `deleteMasteryState`，守单写者）。
3. 对每个 `fsrs_snapshots[i]`：对称处理（`upsertFsrsState` 或新增 `deleteFsrsState` in `src/server/fsrs/state.ts`）。
4. 写一条补偿 `CorrectEvent(correction_kind='retract')`，`subject_id = attemptEventId`，`caused_by = attemptEventId` —— 复用 `revert-auto-enroll.ts:113` 的精确模式。这条 retract 同时让读层（`effective-truth`）把原 attempt 标记为非 active，**双轨一致**：读层投影 + 物化状态都回滚了。

### 级联问题（核心难点）—— owner 拍板「最近优先 / 反时序」

**问题本质**：θ̂ 是路径依赖的。若 attempt A → attempt B 都更新了 KC `k`，B 的快照 `before` 记的是「A 之后的 θ̂」。直接 revert A（写回 A 的 before）会**冲掉 B 的贡献**（θ̂ 跳回 A 之前，但 B 仍「发生过」）。

**这正是 YUK-363 scope 里「caused_by 多跳反向遍历器（recursive CTE）+ 级联 revert（撤 PR-N + 所有 caused_by 下游，反依赖序追加补偿事件）」要解决的**。落地策略：

**策略 A —— 时序级联（推荐，对 θ̂/FSRS 正确）**：revert 一个快照时，找出该 attempt **之后**所有更新了**同一批 KC / FSRS subject** 的快照 event，按 `created_at DESC`（最新优先）逐条恢复其 `before`。等价于：把这批 subject 的状态倒带到「被 revert 的 attempt **之前**」，然后**丢弃**被 revert 的那次，**保留**其后的（但其后的需要重算 —— 见下）。

但这里有个真实的语义裂口：**纯快照恢复无法「保留后续、只删中间」**。快照只能把状态恢复到某个历史点，不能「抽掉中间一次 attempt 后让后续重新生效」（那需要重放，正是 owner 否决的）。所以两个可行收敛：

- **A1（倒带到 attempt 之前，丢弃含后续）**：revert 把同批 subject 倒回被 revert attempt 的 before，所有更晚的同 subject attempt 也一并标 retract（级联 retract）。语义 = 「从这一刻起这条线全撤」。对 copilot per-utterance PR（YUK-363 上游 ADR-0041）场景天然契合：撤一个 PR-N = 撤它及其下游因果链。
- **A2（只允许 revert 最新）**：约束 revert 只能作用于某 subject 的**最近一次** attempt（其 `after` == 当前物化状态）。要撤更早的，必须先撤更晚的（栈式 LIFO）。实现最简单、零裂口，但 UX 受限。

**推荐 A1 + caused_by 因果链**：级联范围由 **caused_by recursive CTE** 界定（撤 PR-N 及其因果下游），而非「时间上所有后续」。即：被 revert 的 attempt + 所有 `caused_by` 指向它（直接或传递）的 event 的快照，按反依赖序（叶子先、根后）逐条恢复 before。这把「时序」收窄成「因果」，避免误撤无关的并行 attempt。当前 `getEventChain`（`queries.ts:943`）只做**单跳**反向（`eq(event.caused_by_event_id, id)`）—— **YUK-363 明列要补 recursive CTE 多跳遍历器**，这是级联 revert 的前置。

**冲突检测护栏**：恢复某 subject 的 before 前，断言「该 subject 当前物化状态 == 待恢复快照的 after」（即没有未在级联范围内的 attempt 偷偷改过它）。不等则 409 拒绝（类似 `paper-submit.ts:437` 的 changed-content 409），防止静默冲掉范围外的更新。

---

## 4. 与结构性表重算路径的统一编排（问题④）

YUK-363 把改造分成两类：**结构性表**（knowledge / knowledge_edge / artifact / question_block.structured / mistake_variant / goal / learning_item）走**真 event→projection 重算（fold）**；**θ̂/FSRS** 走**快照恢复**。一个 PR / 级联可能同时含两类写（例：copilot 一句话既建了 knowledge 节点又触发了一次 attempt）。统一编排：

### 双路 revert 共用一个「补偿事件 + 反依赖序」骨架

两条路径在级联 revert 器里统一为同一接口：

```
RevertableEffect {
  kind: 'structural_fold' | 'state_snapshot',
  revert(tx): Promise<void>   // 把这一步的 projection 影响撤掉
}
```

- **结构性 fold effect**：revert = 对受影响的结构 subject（如某 knowledge 节点）**重放剩余 active event** 重算 projection。撤一个建节点 event 后，重跑该节点的 fold（active event 集已不含被撤的）→ 节点消失或回到前态。这是 YUK-363 的结构半边，**不在本勘察范围**，但接口要对齐。
- **state_snapshot effect**：revert = §3 的恢复快照（命令式写回 before / 删行）。

**统一编排器**（一个 PR-level / cascade-level revert orchestrator，放新模块如 `src/server/revert/cascade.ts`）：
1. 用 recursive CTE（YUK-363 新增）算出因果闭包：被 revert 的根 event + 所有传递 caused_by 下游。
2. 把闭包内每个 event 映射成 0..N 个 `RevertableEffect`（结构 event → fold effect；attempt/review event → 找它的 `experimental:state_snapshot` 子 event → snapshot effect）。
3. **拓扑排序按反依赖序**（叶子先撤，根后撤）—— 结构性表有 FK 序（`FK_ORDER`，`constants.ts:60`），θ̂/FSRS 是 polymorphic 无 FK 但有「同 subject 时序」依赖。两类合并到一个反序队列。
4. 同一个外层 tx 内依次 `effect.revert(tx)`，每个 effect 内部写各自的补偿 event（结构：fold 后写 retract；快照：写回 + retract）。
5. 失败整体回滚（一个 tx）。

**关键统一点**：两类 revert 都遵循 append-only + 补偿 event（`revert-auto-enroll.ts:113` 的 retract 模式是共同基底）—— 没有任何一类做 hard-delete（θ̂ 的 `before=null→删行` 是删**物化投影**行，不是删 event，event 永远 append-only）。读层（`effective-truth`）对两类都靠 CorrectEvent retract 统一过滤。

### θ̂/FSRS vs 结构性的本质差异（编排器必须知道）

| 维度 | 结构性表 | θ̂/FSRS |
|---|---|---|
| revert 方式 | event 流 fold 重算 | 快照命令式写回 |
| 是否路径依赖 | 否（fold 幂等可重算） | 是（Elo/ts-fsrs 累积） |
| 级联后能否「保留后续」 | 能（重算剩余 active 集） | **不能**（快照只能倒带）→ 必须级联 retract 后续 |
| cold-start 哨兵 | 节点不存在 = fold 自然产出空 | `before=null` 显式删行 |

这个差异是编排器路由的依据：结构性 effect 可单点 revert（重算自动处理后续），θ̂/FSRS effect 强制级联（A1 因果闭包）。

---

## 5. 存储成本 + GC（问题⑤）

### 量级估计

单条 `experimental:state_snapshot` event 的 payload：
- 每个 `theta_snapshot` entry：before+after 各 ~5 字段（4 个 number + 1 timestamp）≈ 150-200 bytes JSON。一题平均挂 1-3 个 KC（`q.knowledge_ids`）→ θ̂ 部分 ~200-600 bytes。
- 每个 `fsrs_snapshot` entry：before+after 各一个 ts-fsrs Card dump（`FsrsStateSchemaT`：difficulty/stability/reps/lapses/state/last_review/due 等 ~8-10 字段）≈ 300-400 bytes/half → ~700 bytes/entry。review 路径单 subject，paper 路径单 slot → 通常 1 个 FSRS entry ~700 bytes。
- envelope（event 行：id/actor/action/subject/caused_by/created_at/affected_scopes…）~300 bytes。

**单条快照 event ≈ 1.2-1.8 KB**（含 jsonb 开销，PG TOAST 阈值 ~2KB 内，不会外溢压缩）。

**频率**：每次 attempt/review submit 一条。单用户自用工具，假设重度使用 100-300 attempt/天 → **0.12-0.5 MB/天 → ~50-180 MB/年**。与现有 `event` 表本身（每 attempt 已写 attempt+judge 两条 event）同量级，**快照让每 attempt 的 event 写入从 ~2 条变 ~3 条，存储 +50%-80%**。绝对量对单用户 PG 完全无压力。

### 是否需 GC

**短期不需要专门 GC，长期需要分层策略**：

- `prune_job_events.ts:11` 删的是 `job_events`（SSE 传输层痕迹，30 天 cutoff），**不能照搬到快照** —— 快照是 revert 能力的载体，删了就失去对应 attempt 的可逆性。
- **与 D17 推翻直接冲突**（gate doc §1.6 + YUK-355）：owner 拍定慢热资产「不可丢、必须可恢复」，`event` / `mastery_state` / `material_fsrs_state` 全在 `FK_ORDER`（`constants.ts:60-78`）被全量备份。快照 event 既然进 `event` 表，**自动随备份恢复**（备份层零额外工作）。但这也意味着**不能激进 GC**。
- **推荐分层（非本 wave）**：① revert 窗口设期限（如「只保留最近 90 天的快照可 revert」），超期快照 event 可压缩（before/after 合并存 diff，或只留 retract 能力丢明细）；② 已被 revert 消费过的快照（其 attempt 已 retract）可标记为冷数据；③ 真要降存储，用 PG 分区表按 `created_at` 月分区 + 老分区 `before` 半边 null 化。这些都是 follow-up，本勘察只标量级 + GC 红线（**别照 prune_job_events 无脑删**）。

---

## 文件坐标速查（file:line）

| 关注点 | 位置 |
|---|---|
| attempt→event tx（散题） | `src/capabilities/practice/api/submit.ts:373-600`（`persistSubmit` 的 `db.transaction`）|
| ├ writeEvent(attempt/review) | `submit.ts:494` |
| ├ writeEvent(judge) | `submit.ts:545` |
| ├ upsertFsrsState | `submit.ts:577`（before 在 `:389-431` `prevStateRow` / `update.stateAfter`）|
| └ updateThetaForAttempt | `submit.ts:592`（传 `q.knowledge_ids` 全集）|
| attempt→event tx（组卷） | `src/capabilities/practice/server/paper-submit.ts:301-613`；FSRS `:570`、θ̂ `:590` |
| θ̂ 单写者 + 覆盖写 | `src/server/mastery/state.ts:143`（`updateThetaForAttempt`）；θ̂ 覆盖 `:211-223`；`upsertMasteryState` `:52` |
| θ̂ 数学（路径依赖根因） | `src/core/theta.ts:90`（`conjunctiveCredits`）、`:44`（`eloK`）、`:57`（`updateTheta`）|
| FSRS 单写者 | `src/server/fsrs/state.ts:37`（`upsertFsrsState`）；read `:72`（cold-start 返 null）|
| 表 schema | `src/db/schema.ts:679`（`material_fsrs_state`）、`:714`（`mastery_state`，含 `default 0` 冷启原点）|
| 通用 correct 路由（**不碰 θ̂/FSRS** = 不可逆现状） | `src/capabilities/observability/api/event-correct.ts:63` |
| 读层 retract 过滤（不重算物化） | `src/server/events/corrections.ts:42`、`src/capabilities/practice/server/effective-truth.ts:120` |
| **before/after 快照先例** | `src/capabilities/practice/server/proposal-appliers.ts:668`（`experimental:question_structure_edit`）|
| retract 补偿 event 模式 | `src/capabilities/ingestion/server/revert-auto-enroll.ts:113` |
| event 写入单一入口 | `src/server/events/queries.ts:1020`（`writeEvent`，experimental 松守）|
| caused_by 反向（**仅单跳** → 级联需补 recursive CTE） | `src/server/events/queries.ts:943`（`getEventChain` `:960`）|
| experimental escape hatch（快照走此路） | `src/core/schema/event/experimental.ts:134`（`ExperimentalEvent`）、`:116`（`RESERVED` 不含快照）|
| 单写者红线（约束快照写器落点） | `tests/integration/step9-invariant-audit.test.ts:156`(FSRS)/`:170`(mastery) |
| 备份覆盖（D17 不可丢，含 event/两投影表） | `src/server/export/constants.ts:60-78`（`FK_ORDER`）;反向断言 `archive.ts:81` |
| GC 不可照搬对象 | `src/server/boss/handlers/prune_job_events.ts:11`（30 天删 job_events，**非** event）|

## Linear

**无需新建 issue。** 该工作已由 **YUK-363**（"event-sourcing 地基改造：projection 表撤事件→重算 + θ̂/FSRS 快照可逆"，High，parent YUK-203，2026-06-15 立项）覆盖，其 scope 逐字包含本勘察的全部五点（快照 before/after、结构性 fold 重算、caused_by recursive CTE 级联 revert、与 B1 不冲突的旁路 append）。YUK-363 的「流程」段明写「深度 design workflow（勘察 4 硬问题）→ cross-统合改造设计 → ADR 化」—— 本报告即该勘察 pass 的产物，应作为 YUK-363 的设计输入归档（建议把本报告贴进 YUK-363 评论或转 ADR）。配套 follow-up（已各自有 issue，无需新建）：YUK-355（mem0 备份）、YUK-333（question_edit retract 静默 no-op，同类不可逆 bug）。


## §C 级联遍历

I now have a complete picture. Important: judge events DO use `caused_by_event_id` to chain to the attempt (line 351: `eq(event.caused_by_event_id, attemptEventId)`) — so judge IS on the caused_by graph. But `correct` events chain via BOTH `caused_by_event_id=targetEventId` AND `subject_id=targetEventId`. This means a naive reverse-caused_by walk would pull correction events as "downstream" — which is wrong for cascade revert (you don't revert the correction, the correction IS the compensation). `getEventChain` already excludes them with `ne(event.action, 'correct')`. This is a critical edge for the cycle-guard / filter design.

I have enough to deliver the design. Let me compile the findings.

---

# 级联 revert：caused_by DAG 反向遍历器设计（只读勘察）

## 0. 现状校正（对 map 的修订）

- **caused_by 写入点远多于 map 所说的「proposal-tools.ts 11 处」**。实际全仓 `ctx.causedByEventId ?? null` 落点 ≈14 处（`src/server/ai/tools/proposal-tools.ts:491,547,635,843,1169,1244,1357,1422,1757,2014,2087,2154`），外加 mirror-event 路径 `src/server/ai/tools/mcp-bridge.ts:289`，以及非 copilot 路径（ingestion / agency / notes）多处。
- **`author-artifact.ts` 不是「inline 写没设 caused_by」那么简单**：`src/server/ai/tools/author-artifact.ts:108` 的 `db.insert(artifact)` 是**实体写**，本就不该带 caused_by（artifact 表无此列、也不该有）。它的因果留痕走 `mirrorEvent: 'when_causal'`（`author-artifact.ts:151,277`）→ 由 mcp-bridge 写一条 `tool_use` 镜像 event，**那条 event 才带 `caused_by_event_id: ctx.causedByEventId`（mcp-bridge.ts:289）**。所以 author_artifact 的 caused_by 链是否成立，取决于 `ctx.causedByEventId` 是否被传进 ToolContext —— 这是真正的补全面（见 §5）。
- **没有任何 `WITH RECURSIVE` SQL 地基**。map 说的「structure.ts/tree.ts/body-blocks.ts 是别的树」属实，但要纠正：这三处全是**内存 JS 递归**（`tree.ts:87-96` parent-chain while 循环 + depth<32；`structure.ts:163` `nodeToStructured` 树递归；`body-blocks.ts:240` `visit` 树递归），**不是 SQL CTE**。`tree.ts:29-35` 甚至留了 phase-deferred 注释「PHASE-DEFERRED…replace…with a recursive-CTE…(YUK-236)」——即递归 CTE 在本仓**从未落地过**。本遍历器将是仓库第一个真 `WITH RECURSIVE`。

## 1. caused_by 图的真实拓扑（设计的关键约束）

遍历器要正确，必须先认清 event 因果图不是单一 caused_by 边，而是三类边交织：

| 边类型 | 列 | 语义 | 谁建 |
|---|---|---|---|
| **A. caused_by 正向** | `event.caused_by_event_id → event.id` | 「这条事件由那条引起」 | proposal-tools / mcp-bridge mirror / chat reply |
| **B. subject 指向 event** | `event.subject_id → event.id`（当 `subject_kind='event'`） | judge / rate / correct 作用于某 prior event | event-correct / proposal-appliers / judge |
| **C. 补偿边（B 的特例）** | correct 事件 `caused_by_event_id = subject_id = targetEventId` | 撤销动作本身 | `event-correct.ts:69,72` |

**关键陷阱**：`correct` 事件**同时**用 caused_by **和** subject_id 指回 target（`event-correct.ts:69` `subject_id: targetEventId` + `:72` `caused_by_event_id: targetEventId`）。一个朴素的「反向沿 caused_by 收集下游」会把**补偿事件本身**当成 PR-N 的下游一起再补偿 —— 死循环/二次撤销。

`getEventChain`（`queries.ts:943-979`）已经踩过这个坑并给了正解：反向查询带 `ne(event.action, 'correct')`（`queries.ts:967`），把 correct 事件踢出「caused_events」、单独走 corrections 通道。**遍历器必须沿用同一过滤**：反向 frontier 永远排除 `action='correct'`，否则 cycle guard 也救不了语义错误（补偿事件是合法新节点，不是脏链）。

判断 / 归因（judge / user_cause）则是「真下游」，**必须**收：`getJudgeForAttempt`（`queries.ts:351`）证明 judge 用 `caused_by_event_id=attemptEventId` 挂在 attempt 下 —— 撤一个 attempt 必须连带补偿其 judge（否则判分结果悬空）。

## 2. 遍历器设计：`collectCascadeFromCheckpoint`（recursive CTE + cycle guard + depth limit）

**落点**：新增 `src/server/events/cascade.ts`（与 `corrections.ts` / `queries.ts` 同层，事件域 owner）。读路径，纯 SELECT。

**签名**（建议）：
```
collectCascadeFromCheckpoint(db, checkpointId: string, opts?: { maxDepth?: number; maxNodes?: number })
  → { nodes: CascadeNode[]; truncated: boolean; cycleHit: boolean }
```
`CascadeNode = { id; action; subject_kind; subject_id; caused_by_event_id; depth; created_at }`，按 `depth DESC, created_at DESC` 排序输出（= 反拓扑序，见 §3）。

**核心 SQL（drizzle `sql` 模板，仿 `getPartitionedFailureRows` 的 raw-sql-in-drizzle 写法 `queries.ts:868`）**：

```sql
WITH RECURSIVE cascade AS (
  -- 锚：PR-N = user_ask checkpoint 事件本身
  SELECT e.id, e.action, e.subject_kind, e.subject_id,
         e.caused_by_event_id, 0 AS depth,
         ARRAY[e.id] AS path           -- cycle guard 累积路径
  FROM event e WHERE e.id = $checkpointId
  UNION ALL
  -- 反向一跳：所有 caused_by 指回当前 frontier 的事件
  SELECT c2.id, c2.action, c2.subject_kind, c2.subject_id,
         c2.caused_by_event_id, cascade.depth + 1,
         cascade.path || c2.id
  FROM event c2
  JOIN cascade ON c2.caused_by_event_id = cascade.id
  WHERE c2.action <> 'correct'          -- §1 陷阱：排除补偿事件（getEventChain:967 同款）
    AND c2.id <> ALL(cascade.path)       -- cycle guard：脏链不无限递归
    AND cascade.depth < $maxDepth        -- depth limit：硬顶（建议 64，远超 turn 内实际链深）
)
SELECT DISTINCT ON (id) * FROM cascade ORDER BY id, depth;
```

**护栏三件套**（CLAUDE.md「护栏两层语义」+ 防脏链）：
1. **cycle guard**：`path` 数组累积 + `c2.id <> ALL(path)`。Postgres 原生 `CYCLE … SET … USING` 语法在更高版本可用，但 `path` 数组写法与现有 pg 版本无关、最稳。
2. **depth limit**：`cascade.depth < $maxDepth`（硬顶）。理由：CLAUDE.md 偏好「硬顶 3-5× 只防事故」；turn 内 caused_by 链实测 ≤ 几跳，64 是事故熔断不是正常约束。
3. **node cap**：CTE 外层套 `LIMIT $maxNodes`（仿 `tree.ts:36` `LOAD_TREE_SNAPSHOT_LIMIT=5000`）+ 截断时 `console.warn`（仿 `warnIfTreeSnapshotTruncated` `tree.ts:44`）。`truncated=true` 时上层**必须拒绝级联 revert 并要求人工**（截断的级联 = 漏补偿 = 派生态半残）。

**注意 subject_id（B 类边）要不要进 CTE**：v1 **只沿 caused_by**（A 类）做主递归，judge / user_cause 因为本就用 caused_by 挂载（§1）会被自动收进。`subject_id='event'` 的额外反向边（rate / 其它 correct）在 v1 不进递归 —— rate 是用户决策、correct 是补偿，都不该被级联撤。这与 `getEventChain` 的「caused_events 只走 caused_by、corrections 单独走 subject_id」分层一致。

## 3. 反依赖序补偿编排

**落点**：新增 `src/server/events/cascade-revert.ts`（写路径，但只追加 event，不破坏）。复用 `event-correct.ts` 的补偿写法（`writeEvent` + `action='correct'`）。

**编排步骤**：
1. `collectCascadeFromCheckpoint(checkpointId)` → `nodes`（已按 `depth DESC` = 最下游优先）。
2. **反拓扑序追加补偿**：从最深 depth 往锚走，对每个 node 追加一条 `correct` 事件。**最下游先撤**保证撤一条边时它引用的上游还没被撤（与 ADR-0041:19 「撤早期 PR 级联，按 caused_by 反依赖序」一致）。
3. **CorrectionKind 选择**（`known.ts:229`）：
   - propose / generate / 结构写 → `retract`（整条作废）。
   - 被 supersede 链替换过的 → `restore` 上一版 or `retract` 替换版（看是否要回滚到 supersede 前）。
   - 用户已 `mark_wrong` 的不动（用户决策优先于级联）。
   - `supersede` 仅在「revert = 换成另一版本」时用（需 `replacement_event_id`，`known.ts:249` superRefine 强制）。
4. **每个补偿事件**：`subject_kind='event'`, `subject_id=<被撤 event id>`, `caused_by_event_id=<被撤 event id>`（沿用 `event-correct.ts:69,72` 形状），`affected_refs` 取被撤事件影响的 ActivityRef（`known.ts:244` min(1) 强制）。
5. **派生态重算**：补偿事件写完后，`getCorrectionStatuses`（`corrections.ts:42`）会让所有读路径（`getEvents` / `getFailureAttempts` / `getJudgeForAttempt`）经 `resolveEffectiveActiveRows` 自动跳过被 retract 的行 —— **结构性派生态（mastery view / 错题队列 / 知识树）是纯派生，自动重算，无需手动触发**。这是 ADR-0006 红利（ADR-0041:19）。

**全程单事务**：整个级联补偿在一个 `db.transaction` 内（仿 proposal-appliers 的 tx 模式），要么全撤要么不撤，避免半残 PR。

## 4. 不可逆下游边界（per-utterance 窗口的诚实边界）

把下游分三类，对应 ADR-0041:52「approve-before → revert-after，有『改了才撤』的窗口」：

| 类别 | 例子 | 可撤？ | 机制 |
|---|---|---|---|
| **纯派生 projection** | 知识树节点/边、mastery view、错题队列、artifact 内容 | ✅ 干净撤 | 追加 `retract`/`restore`，读路径派生重算（§3.5） |
| **实体行（带乐观锁）** | `artifact`（author_artifact 写的 row）、`knowledge` 节点、`practice_stream_item` 排入 | ✅ 软删 | `archived_at` 软删（artifact 有此列 `schema.ts:344`）；practice_stream_item 标 skipped/删行；冲突走 409（ADR-0041:60 复用乐观版本锁） |
| **既成事实（不可撤）** | 真 **attempt** 事件（`schema.ts` AttemptOnQuestion）、**review** 事件 + FSRS 入册（`material_fsrs_state`）、用户已 `user_verified` 的块 | ❌ 撤不掉 | attempt/review 是**用户真发生的行为事实**，retract 它等于篡改历史。FSRS 状态是 attempt 的派生但已影响排程 |

**边界的精确表述**：
- **题进 frontier（practice_stream_item 排入）= 可撤**（用户还没练，只是被排进来）。
- **真 attempt / review 已发生 = 不可撤**。撤 PR-N 时若级联触及一个已被 attempt/review 引用的下游，遍历器必须**停下并告知**：「PR-N 的下游 X 已产生真实练习 attempt（事件 e_NNN），无法干净级联撤销」。
- **FSRS 入册（`material_fsrs_state.last_review_event_id` `schema.ts:692`）/ θ̂（`mastery_state.theta_hat` `schema.ts:721`）= 快照恢复路径**，不是重算路径：这些是有状态累积器（PFA success/fail count），retract 一条 review 不会自动回退 θ̂。**v1 的诚实做法是：触及 FSRS/mastery 的级联 = 不可逆，拒绝 + 告知**；真要恢复需从 attempt 事件流全量重放 FSRS（昂贵，phase-deferred）。

**per-utterance 窗口的诚实边界**（ADR-0041:59）：turn 内（你刚说完一句话、还没去练）级联 revert 几乎总是干净的（下游全是 projection + 实体行）。跨 turn 撤旧 PR 才会撞上「已练 attempt」——窗口越久，不可逆下游越多。遍历器应在 collect 阶段就**标记每个 node 的可撤性**（`reversibility: 'derived' | 'entity' | 'irreversible'`），让上层 PR diff 面如实展示「这个 PR 还能干净撤 / 部分撤 / 不能撤」。

## 5. PR 关闭 vs revert（durable run 边界）

依据 ADR-0041:34,40「durable-run 形态：run handle = checkpoint_id；PR 等该句话派出的所有 async job 落完才关闭可审」：

- **durable run 未落完事件时 PR 不能关**：一句话可能派出 durable pg-boss job（`business_table='copilot_run', business_id=user_ask event id` ADR-0041:34），job 还在跑 = 这个 checkpoint 的 commit 图还没成型（caused_by 链还在增长）。此时 `collectCascadeFromCheckpoint` 会**漏收尚未写入的下游事件** → 级联 revert 不完整。**判据**：PR 仅当其 checkpoint_id 对应的所有 `job_events`（`schema.ts:525`）流到达终态（done/cancelled）才进入「可 revert」。运行中 PR 只能 **cancel job + partial 留 live**（ADR-0041:34 「显式停止→打断…partial 留 live + partial PR 进 keep/revert」）。
- **已关 PR 的 revert ≠ 未关 PR**：
  - **未关（运行中）PR**：先 cancel job，partial 事件已落 live，再对已落部分跑级联补偿。
  - **已关（落完）PR**：commit 图稳定，直接 `collectCascadeFromCheckpoint` + 全量反序补偿。
- **interrupt/queue 串行化**（ADR-0041:35）：n=1 一次一 run，不并发。级联 revert 也应串行 —— 撤 PR-N 时不能有另一个 durable run 正在写同图（否则补偿事件与新写竞争乐观锁 = 409 地狱）。revert 前应检查无 in-flight run。

## 5b. caused_by 一致性补全清单（file:line）

要让 `collectCascadeFromCheckpoint` 收全一个 PR 的所有下游，**每条 copilot turn 内的写都必须 caused_by 链回 user_ask**。现状审计：

**已正确设置（caused_by = ctx.causedByEventId，而 ctx.causedByEventId 在 chat.ts:712/736 = userAskEventId）**：
- ✅ proposal-tools.ts 全部 propose 写：`:491,:547,:635,:843,:1169,:1244,:1357,:1422,:1757,:2014,:2087,:2154`
- ✅ mcp-bridge mirror event（含 author_artifact / update_artifact / write_quiz 的因果留痕）：`mcp-bridge.ts:289`（`caused_by_event_id: ctx.causedByEventId ?? null`）
- ✅ chat reply 事件：`chat.ts:826`（teaching pack）、`chat.ts:1099`（free-form）

**需补全 / 需核验**：
1. **`ctx.causedByEventId` 是否真传到 worker 进程的 ToolContext** —— ADR-0041:55 点名「worker 面 copilotTools 只半接线（half-wired gap）」。durable copilot job 跑在 worker（`scripts/worker.ts`），若 worker bootstrap 没把 user_ask event id 透传进 `ToolContext.causedByEventId`，则 durable run 内所有 mirror/propose 事件 `caused_by=null` → **整条下游脱链、级联 revert 漏收**。**这是补全的头号项**（ADR-0041:55「实施波次第一个要补」）。核验点：`src/server/ai/tools/bootstrap.ts` + `scripts/worker.ts` 的 ToolContext 构造。
2. **`author-artifact.ts:108` 的 artifact 实体写** —— 结论：**artifact 表不加 caused_by 列**。artifact 是实体不是事件；它的因果归属走 mirror event（mcp-bridge.ts:289）+ `generated_by.task_run_id`（`author-artifact.ts:122`）。补全方式 = 确保 mirror event 真被写（依赖 §1 的 `ctx.causedByEventId` 传入）+ 级联 revert 时由 mirror event 反查到 artifact_id 做 `archived_at` 软删。**inline 写不改走 event 表**（实体/事件分离是 ADR-0006 地基，不破坏）。
3. **`update_artifact`（author-artifact.ts:183-266）无 writeEvent**（注释 `:191-197` 明说靠 mirror）—— 同 #2，依赖 mirror event 的 caused_by。但 update 的 rollback 靠 mirror args 链（`author-artifact.ts:27-33`），级联撤 update 需特殊处理（恢复 v(n-1) html 而非软删整个 artifact）。
4. **chat.ts chip 路径**：`chat.ts:736` 用 `chipEventId` 作 causedBy（不是 user_ask）。chip turn 的 PR 锚是 chip event 而非 user_ask —— 设计上 OK（chip 也是一个 checkpoint），但 `checkpoint_id` 定义要涵盖「user_ask OR chip event」两类锚。
5. **非 copilot 写路径的 caused_by 不进 copilot PR 图**：ingestion/agency/notes 的 caused_by（如 `auto-enroll.ts:406`、`mistakes.ts:180`）是各自领域的因果链，**不应**被 copilot PR 级联误收 —— 遍历器以 `user_ask`/`chip` 锚 + caused_by 反向，天然只收锚下游，不会跨界。但要确保锚选对（只 copilot 的 user_ask）。

## 6. Linear issue 捕获

本任务为只读深挖勘察，输出设计。发现的可落地 follow-up（已在 ADR-0041「实施细节 deferred」节 + draft-layer doc §待续 登记，承 YUK-203 批量建票计划 ADR-0041:61）：

- **未发现需新建的孤立 follow-up**：级联 revert 遍历器、caused_by 补全、worker copilotTools half-wired gap、`propose_*` rename 均已在 `docs/adr/0041-copilot-truly-capable-reach-endurance-checkpoint.md:55,56,61` 和 `docs/design/2026-06-15-copilot-agentic-checkpoint-draft-layer.md:58-62` 显式记为待 ADR 化时批量建 Linear 票（承 YUK-203）。本设计是对其中「级联 revert 机制（核心待挖）」「补全 copilot 写路径 caused_by」两项的细化，不构成新增遗漏项。
- 唯一**值得单独提请注意**的（建议建票，若尚未在批量计划中拆出）：**worker 进程 `ctx.causedByEventId` 透传**（§5b #1）是级联 revert 正确性的**硬前置**（durable run 脱链会让整个机制漏收下游），优先级应高于 `propose_*` rename。其余按 ADR-0041:61 既有批量计划推进即可，无需我额外开票。

## 关键 file:line 索引

- 遍历地基（单跳，待泛化）：`src/server/events/queries.ts:943-979`（getEventChain，含 `ne(action,'correct')` 过滤 `:967`）
- 补偿写法范本：`src/capabilities/observability/api/event-correct.ts:63-74`（correct 事件 caused_by=subject_id=target）
- CorrectionKind 定义：`src/core/schema/event/known.ts:229`（supersede/retract/mark_wrong/restore）+ superRefine `:248-263`
- 派生态自动重算：`src/server/events/corrections.ts:42-107`（getCorrectionStatuses）
- caused_by 索引（单跳支撑）：`src/db/schema.ts:642`（event_caused_by_idx）
- user_ask 锚写入：`src/capabilities/copilot/server/chat.ts:688-712`（userAskEventId）+ chip 锚 `:715-737`
- ctx.causedByEventId 注入 tool loop：`src/capabilities/copilot/server/chat.ts:931-934`
- mirror event caused_by：`src/server/ai/tools/mcp-bridge.ts:289`
- artifact 实体写（无 caused_by 列，正确）：`src/server/ai/tools/author-artifact.ts:108`；artifact 表 `src/db/schema.ts:325-348`（有 archived_at `:344`，无 caused_by）
- 内存递归（非 CTE，仅借鉴 depth/cycle 思路）：`src/capabilities/knowledge/server/tree.ts:87-96`（while+depth<32）+ phase-deferred CTE 注释 `:29-35`
- 不可逆下游表：`material_fsrs_state` `src/db/schema.ts:679-693`、`mastery_state` `src/db/schema.ts:714-742`、attempt/review 事件 `src/core/schema/event/known.ts:27,117`
- durable run 边界：`docs/adr/0041-copilot-truly-capable-reach-endurance-checkpoint.md:34,40,55` + `job_events` 表 `src/db/schema.ts:525`
- 设计源：`docs/design/2026-06-15-copilot-agentic-checkpoint-draft-layer.md:58-62`（级联 revert 五项待续）


## §D 迁移风险+分wave

I now have complete grounding. YUK-363 already captures the work and even pre-decides two key things owner ratified today: (1) the θ̂/FSRS **snapshot** approach (not full-replay), and (2) structural tables go true event→projection rebuild. My analysis converges with and extends it. No new Linear issue is needed — this is the design-workflow grounding pass *for* YUK-363. I have everything needed to deliver the strategy.

---

# Event-sourcing 大改造：迁移风险 + 分 Wave 策略（只读勘察，YUK-363 grounding）

## TL;DR — 三个改变任务定性的事实

1. **这不是「引入 event sourcing」，是「把 event-logged 升级为 event-sourced」。** `event` 表（`src/db/schema.ts:597`）+ `KnownEvent` discriminated union 早已存在且严格单写（`writeEvent`，ADR-0005/0006v2）。九张表中 3 张已经是**显式声明的 event-derived projection**，6 张是**带 `version` 乐观锁的命令式实体**。Linear **YUK-363 已立项**（today，High，parent YUK-203），owner 已拍板走大改造，并已预定两个关键方案——所以本勘察是 YUK-363 的 design-workflow grounding，**不需新开 issue**。

2. **九张表分两类，决定整个 Wave 策略**（这是核心结论）：
   - **A 类 · 已是 event-derived 投影**（无 `version`、单写者模块、已在 `FK_ORDER` 标注「rebuildable」）：`mastery_state`（`schema.ts:714`）、`material_fsrs_state`（`:679`）、`item_calibration`（`:760`）。
   - **B 类 · 命令式实体**（带 `version` + `expected_version` 乐观锁，行本身即真相，event 是 provenance/审计链）：`knowledge`（`:50`）、`knowledge_edge`（`:791`）、`artifact`（`:325`）、`question_block`（`:102`）、`learning_item`（`:207`）、`goal`（`:866`）、`mistake_variant`（`:833`）。

3. **「fold(events)→projection」重算路径当前在全九表里几乎不存在。** 全仓库唯一真正的 replay 先例是 `rebuildProposalDecisionSignal`（`src/server/proposals/signals.ts:347`，重放 `event` 的 rate 决策重建 `proposal_signals`）。`mastery_state`/`material_fsrs_state` 是在 attempt tx 内**前向增量**写的（`updateThetaForAttempt`，`src/server/mastery/state.ts:143`；`upsertFsrsState`，`src/server/fsrs/state.ts:37`），不是从 event 折叠。这正是实施前 gate ②c 已明确点出的缺口（见下）。

---

## 1. 现有数据迁移：backfill vs 双轨

**A 类（mastery_state / material_fsrs_state / item_calibration）— 不需要 backfill genesis event。**
- attempt/review 的事实**早已**只写 `event`（`AttemptOnQuestion`/`ReviewOnQuestion`，`writeEvent`），projection 行只是这些 event 的折叠结果。历史 event 完整存在，所以「从 event 重算」对历史行天然可行——缺的只是**重算函数本身**（fold 算子），不是数据。
- owner 已拍板（YUK-363 + gate ②c）：**θ̂/FSRS 用快照而非全序列重放**。理由硬：ts-fsrs Card 状态机重放确定性难保证、Elo 是原地覆盖、每 attempt 重放代价高。落法 = 保留命令式在线更新逻辑，每次 attempt 在写路径旁 **append 一条带 before/after 快照的 event**，revert = 恢复快照。这等于把 A 类做成「snapshot-augmented event sourcing」，不是纯 fold。

**B 类（结构/实体表）— 走真 event→projection 重算，但有 ADR-0034 红线约束。**
- `knowledge`/`knowledge_edge` 是**结构 = timeless 不变量**（ADR-0034 刚于 2026-06-14 推翻 bi-temporal，明确「结构是无时间属性的事实」）。强行把结构做成「纯 fold(events)」会撞两堵墙：①乐观锁 `version`/`expected_version` 并发模型（`src/capabilities/knowledge/server/proposals.ts:284-289`）；②`knowledge.domain` 是 live 派生（effective_domain，data-assumptions `:244`），不是 event-folded。
- backfill 策略：**反推 genesis event**。已有 B 类行（生产/dev 有数据）没有完整 propose/generate event 历史的，需要为每行生成一条 `genesis`/`import` 补偿 event（`actor_kind='system'`），让 event 流的「当前折叠态」== 现状 projection 行。precedent 已在 `scripts/seed-synthetic.ts`：它写 `writeEvent`（attempts/reviews）**然后**写 projection——即「先 event 后投影」的正确序，backfill 脚本反向用同一序补齐。
- **结论：A 类 = 双轨快照（命令式写保留 + append 快照 event），B 类 = genesis-event backfill + 真 fold 重算。不是单一策略，按类分。**

## 2. 双写期一致性 + 切真相源

**为什么需要双写期**：当前 projection 是命令式写的真相源；event 是审计链。切换 = 让 event 成真相源、projection 成可重建缓存。中间必须有「双写校验期」：写路径同时（a）写 projection（旧真相）和（b）append event + 立即 fold 验证 `fold(events) == projection`，比对一致再切真相源指针。

**独立可切 vs 耦合（按依赖拓扑，`FK_ORDER` 实证 `src/server/export/constants.ts:60`）**：

| 切换难度 | 表 | 依赖 / 写点数 | 理由 |
|---|---|---|---|
| **最易（已半成）** | `material_fsrs_state` / `mastery_state` / `item_calibration` | 各 1 个单写者，零 FK，已声明 derived | 只需补 fold/snapshot 算子 + 反向 replay；单写者契约已被 `step9-invariant-audit.test.ts:156-191` 强制 |
| **中（单写者 + 弱依赖）** | `goal`（4 写点）/ `mistake_variant`（6 写点）/ `knowledge_edge`（2 写点，已禁外部 raw insert，`edges.ts:13`） | 松耦合 text ref | 写点集中、有现成 propose/rate/generate event 路径（ADR-0011） |
| **难（强耦合）** | `knowledge` ← `knowledge_edge`（FK from/to → knowledge，`schema.ts:797-800`）+ `learning_item`（7 写点跨 orchestrator/proposals/agency） | 真 FK + 多写者 | edge 重算必须在 knowledge 重算之后；learning_item 写点散在三个 capability |
| **最难** | `artifact`（**14 个文档化单写者**，跨 notes/ingestion/orchestrator/proposals/ai-tools，`step9-invariant-audit.test.ts:251-289`）+ `question_block`（12 写点散在 ingestion/session） | 多 capability、版本化 block tree、living-note patch 链 | artifact 不是单写者表，是「多写者协议」；event-source 它等于重设计整个 notes 域写契约（与 ADR-0040/YUK-358 笔记域 re-think 重叠） |

**切换顺序铁律**：knowledge → knowledge_edge（FK 序），artifact 末位（依赖最重 + 与笔记域 re-think 冲突面最大）。

## 3. 测试冲击估计

实测（排除 `.claude/worktrees/` 副本）：**372 个 `.test.ts`，其中 207 个走 DB 分区**。碰九表的测试文件数：

| 表 | 测试文件数 | 表 | 测试文件数 |
|---|---|---|---|
| `event` | 155 | `learning_item` | 32 |
| `knowledge` | 125 | `knowledge_edge` | 32 |
| `artifact` | 64 | `material_fsrs_state` | 29 |
| `question_block` | 18 | `goal` | 10 |
| `mistake_variant` | 9 | `mastery_state` | 7 |
| `item_calibration` | 6 | | |

**冲击三层**：
- **现有断言不破**：双写期保证 `fold==projection`，多数读路径测试（占大头）无需改——它们读 projection，projection 仍在。真正受冲击的是**写路径单测**（断言 INSERT/UPDATE 形态的）+ 单写者 invariant 审计。
- **新增测试三类**（每个改造表）：① **重算正确性**（`fold(events) == 命令式写结果`，黄金断言，对照 `triggers.outbox.test.ts` 的真 PG 形制，不 mock）；② **级联 revert**（撤 PR-N + 所有 `caused_by` 下游，反依赖序补偿事件——当前 `caused_by` 只单跳 `eq`，无 recursive CTE 反向遍历，是新代码）；③ **快照可逆**（A 类 before/after 快照 restore 幂等）。
- **hermetic 契约扩展**：当前契约 = 每 DB 测试 `beforeEach` `resetDb()`、不跨文件假设状态/序（CLAUDE.md）。event-source 后**新增不变量**：测试种数据必须「先 event 后 projection」（或只种 event 让 fold 产 projection），否则 fold 校验会发现 projection 与 event 不一致而误报。`step9-invariant-audit.test.ts` 需扩**反向断言**：每个 A 类写者旁必须有对应 snapshot-event append（防止「写 projection 不 append event」的静默漂移）。

## 4. 与三轴正交红线（ADR-0035）的关系

**改造不能破 R⟂p(L)⟂difficulty，且 event-source 后三轴的 event 流必须分离。**
- `material_fsrs_state`（R 维，调度「何时复习」）、`mastery_state`（p(L) 维，诊断「会不会」）、`item_calibration`（difficulty 桥，只读共享输入）三者**当前已各管各、不互写**（`updateThetaForAttempt` 只**读** `item_calibration.b`，从不回写，G4 红线，`state.ts:165-177`）。
- event-source 后红线落点：**三轴的快照 event 必须独立**。同一次 attempt 会同时推 R（ts-fsrs Card）和 p(L)（Elo θ̂），但快照 event 要分两条（或一条 event 内分两个独立 payload 段），revert 时能独立回滚——否则撤一条 event 同时回滚两轴，等于在 revert 路径上制造跨轴耦合，破 ADR-0035 §决定6（「R 与 p(L) 不对账，背离不触发自动修正」）。
- difficulty 桥（`item_calibration.b`）是单写者标定 job 产出的只读锚，**不进 attempt 快照 event**——它的写路径（ItemPriorTask/fixed-anchor）与 attempt 快照是不同 event 流，gate ③H10 已钉死「共享输入非共享估计值」。
- `judge_retraction`/D15 重判（gate ②b）：撤销已计入 p(L) 的 success/fail 是**反向快照恢复**，不是 decrement——这天然契合快照方案，但必须保证只回 p(L) 轴、不碰 R 轴的 FSRS Card。

## 5. 分 Wave 切分 + 与 copilot wave 并行关系

**Wave 0（试点，风险最低/依赖最少/收益最高）= `mastery_state` + `material_fsrs_state` 快照可逆。**
- 理由：① 单写者已就位（`src/server/mastery/`、`src/server/fsrs/`），invariant 审计已强制；② owner 已拍快照方案，无需重写在线更新逻辑，只在写路径旁 append 快照 event；③ 直接兑现 gate ②c（公式调参时「从既有 event 重算既有知识点 p(L)」）+ D17 推翻后的「慢热资产不可丢、必须可恢复」（这两表是 B1 慢热校准载体，#414 刚 merged）；④ 解锁 `judge_retraction` 回滚（gate ②b）。
- 独立可验证：黄金断言 `restore(snapshot) == 命令式写态` + revert 幂等，单表闭环。

**Wave 1 = `knowledge` + `knowledge_edge`（真 fold 重算 + genesis backfill）。** 先 knowledge 后 edge（FK 序）。捆绑 ADR-0034 一致性闸（环/方向/传递冗余，目前**零实现**，是 RT1/RT2/RT4 共同前置）——重算路径正好是装一致性闸的天然位置。

**Wave 2 = `goal` + `mistake_variant` + `learning_item`（意图组织层）。** 写点中等、有现成 propose/rate event 路径。

**Wave 3 = `artifact` + `question_block`（最难，末位）。** 14 个 artifact 写者跨多 capability + 与笔记域 re-think（ADR-0040 / YUK-358 epic）写契约冲突面最大——建议与 YUK-358 合流设计，不要平行造两套 artifact 写契约。

**caused_by 多跳反向遍历器（recursive CTE）+ 级联 revert** 作为横切基建，Wave 0 引入骨架（当前只单跳 `eq`，`retractAiProposal` 多数 kind 无 case），各 Wave 复用。

**与 copilot reach/endurance wave 的关系（关键澄清）**：
- **reach/endurance 两腿与本改造正交、可独立先做**（YUK-363 + reach 设计 `2026-06-15-copilot-reach-endurance-design.md:5,87 双向确认）。reach/endurance「几乎不用新表」，用 `job_events`（已在 `BACKUP_EXCLUDED_TABLES`，operational）做 run 进度、`event` 做 SoT，**所有写都汇进同一确定性 applier 层**（reach 设计 §2.3/2.4）——它改的是「谁触发 applier、同步还是异步」，不改 applier 背后写 projection 还是 append-event-then-fold。
- **唯一耦合点是 checkpoint 腿（第三腿，ADR-0041）**：per-utterance PR + 级联 revert 的核心机制就是「撤事件→派生重算」，而 YUK-363 证伪了它的前提（系统是 event-logged 非 event-sourced）。所以 **本改造是 ADR-0041 checkpoint 腿的真正前置**，ADR-0041 的「派生重算红利」原假设不成立，需据本改造修正为「event-sourced 重算 + 快照混合」。
- 并行编排建议：reach/endurance 与本改造 Wave 0-2 **可并行起跑**；checkpoint 腿 gated 在本改造之后；artifact（Wave 3）与笔记域 re-think 合流。

---

## 关键 file:line 索引

- 九表定义：`src/db/schema.ts` — knowledge `:50` / question_block `:102` / learning_item `:207` / artifact `:325` / event `:597` / material_fsrs_state `:679` / mastery_state `:714` / item_calibration `:760` / knowledge_edge `:791` / mistake_variant `:833` / goal `:866` / knowledge_mastery view `:909`
- 已有单写者投影模块：`src/server/fsrs/state.ts:37`（upsertFsrsState）/ `src/server/mastery/state.ts:143`（updateThetaForAttempt，只读 item_calibration `:165-177`）
- **唯一现存 replay 先例**：`src/server/proposals/signals.ts:347`（rebuildProposalDecisionSignal，fold rate events）
- 单写者 invariant 审计（需扩反向断言）：`tests/integration/step9-invariant-audit.test.ts`（fsrs `:156` / mastery `:170` / item_calibration `:183` / event `:105` / artifact 14 写者 `:251-289`）
- backup 派生分类（D17 推翻后张力点）：`src/server/export/constants.ts:56-59`（A 类标 "rebuildable from event stream" 但 fold 不存在）+ FK_ORDER `:60` + BACKUP_EXCLUDED_TABLES `:96`
- backfill 序先例：`scripts/seed-synthetic.ts:362,483`（writeEvent 后 upsert FSRS）
- 实施前 gate（owner 已批）：`docs/design/2026-06-15-rethink-implementation-gate.md` ②c mastery_state event 回填「无 replay 路径」`:45` / ②b 判定→p(L) 单写含 retraction 回滚 `:44` / ②d 4 表锁步备份反向断言 `:46` / D17 推翻「数据不可丢」`:102`
- 三轴红线：`docs/adr/0035-...md` 决定1（difficulty 共享输入非估计值）+ 决定6（R⟂p(L) 不对账）
- 结构 timeless 红线：`docs/adr/0034-...md`（推翻 bi-temporal，结构无时间属性）
- copilot 并行关系：`docs/design/2026-06-15-copilot-reach-endurance-design.md:5,87`（reach/endurance 几乎不用新表、汇进同一 applier 层、独立于本改造）
- Linear：**YUK-363**（已立项，owner 已拍快照方案 + 结构表真 fold，无需新 issue）；blocker = ADR-0041 checkpoint 腿待本改造修正

**Linear issue 捕获 gate**：无需新建 issue——YUK-363 已完整覆盖本改造，且 owner 今日已拍板方案与 scope；本勘察是其 design-workflow 的 grounding 输入。唯一 follow-up 是改造落地时修正 ADR-0041 checkpoint 假设，已在 YUK-363「关系」段记录，不另立。