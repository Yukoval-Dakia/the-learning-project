# ADR-0044 — event-sourcing 地基改造：projection 重算 + θ̂/FSRS 快照可逆

**Status**: Accepted (2026-06-15)
**Part of**: YUK-203 · YUK-363 epic。ADR-0041 copilot checkpoint 腿的真前置。
**Decision source**: owner 2026-06-15 拍板「走大改造」（全部 projection 表纳入 + θ̂/FSRS 用快照非全重放）。地基 = `docs/design/2026-06-15-event-sourcing-foundation-redesign.md`（5-agent / 651k-token workflow，4 路深挖 + cross-统合，file:line 核验）。前因 = `copilot-omnipotent-map` 证伪「系统已 event-sourced」。
**Related**: **ADR-0041（checkpoint 腿——本 ADR §修正它）** · ADR-0006（event=SoT，本改造把「红利」变成现实）· ADR-0035（三轴正交，θ̂/FSRS 快照两段独立不破 R⟂p(L)）· ADR-0034（一致性闸，Wave 1 合流）· ADR-0042（选题引擎，π_i）· ADR-0040/YUK-358（笔记域，artifact Wave 3 合流）· B1 载体 #414（θ̂/FSRS 写路径，快照方案不重写在线逻辑）。

---

## 背景

ADR-0041 checkpoint 腿（per-utterance PR + 级联 revert）的核心机制是「撤事件→派生重算」（引 ADR-0006 event=SoT）。`copilot-omnipotent-map`（6 路 grounding）对着代码证伪了前提：

**这个系统是 event-logged，不是 event-sourced。** `event` 表是审计痕迹，不是 projection 唯一真相源——所有状态（knowledge/knowledge_edge/artifact/question_block.structured/mistake_variant/goal/learning_item/mastery_state/material_fsrs_state）都是命令式 insert/update 写的，撤 event 行 projection 纹丝不动。`computeReplay` 只是 SSE 传输层断线重放，无 `event流→projection` 重算路径；caused_by 多跳反向遍历不存在（只单跳 eq）；retractAiProposal 多数 kind 无 case。

owner 拍板：把系统真正升级为 event-sourced，让 checkpoint/级联 revert 可信。

## 决定

### 1. 重算引擎：结构性 projection 走 fold(events)→row（materialized write-through）

四张结构表（knowledge / knowledge_edge / artifact / question_block.structured）+ 三张实体表（mistake_variant / goal / learning_item）改成「事件唯一真相，projection 是缓存」：
- **fold reducer**（`src/core/projections/<table>.ts` 纯函数，蓝本 `getCorrectionStatuses` corrections.ts:41-106 + `getEffectiveTruth`）→ IO 壳（`src/server/projections/<table>.ts`，物化模式同 `upsertFsrsState`）。
- **增量默认 + 全量兜底**：热路径增量重算受影响实体；`scripts/rebuild-projection.ts` 全量 truncate+fold 用于 backfill / drift audit / 灾难恢复。
- **materialized write-through，不读时 fold**（结构表高频读 + 被 join 引用，读时 fold 不可接受）。乐观锁 version 保留。
- **同 tx writeEvent + reducer apply**（事件 = projection 原子，杜绝「写表没写事件」漂移）。

### 2. event payload 补字段（自足性硬前置）

`fold(events for subject)` 必须不读 projection 重建整行。补字段清单（P0=硬阻断）：
- **P0 #1 — `RateEvent.payload.materialized_ids`**：knowledge accept 时 `applyProposeNew` 当场 `newId()` 生成的节点 id 必须写进 event。不补则重放生成**不同 knowledge.id** → 所有引用断。这是把命令式 id 钉进事件流的关键。
- **P0 #2** — `body_blocks_edit` payload 加全量 `body_blocks`（现仅 version 号）。
- **P0 #3** — `runNoteGenerate` 同 tx 写 `GenerateArtifact` event（现完全不写）。
- **P0 #4** — `GenerateArtifact.payload` 加 type/intent_source/source/parent_artifact_id/knowledge_ids/tool_kind/attrs/body_blocks（5 处 artifact 创建归一到此 action）。
- **P0 #5/#6** — 新 `EditQuestionBlockStructured` KnownEvent（`subject_kind:'question_block'` 新增）+ 编辑后 structured 全树快照；写从 `job_events` 迁到 canonical `event`（job_events 不在真相层）。
- **P1 #7** — artifact 生命周期 status 转移 event。
- knowledge accept：mutation 形态走 rate→propose join（链已存在），生成 id 走 #1 inline。

### 3. θ̂/FSRS 用快照（owner 拍定，非全重放）

mastery_state.θ̂（Elo 原地覆盖）+ material_fsrs_state（ts-fsrs Card）保留命令式在线更新（**不重写 B1 #414 逻辑**），但：
- 每次 attempt 在**同 tx**（attempt event + judge + FSRS upsert + θ̂ update + 快照 event 五者原子）append 一条 `experimental:state_snapshot` event（走 experimental escape hatch，不扩 attempt payload，守单写者）。
- payload = `theta_snapshots[]`（per-KC before/after，before=null 表 cold-start）+ `fsrs_snapshots[]`（before/after，复用 FsrsStateSchemaT）。**两段独立可分别 revert**（守三轴正交 R⟂p(L)，ADR-0035 决定6）。
- **revert = 恢复快照**（before≠null→upsert 写回；before=null→删行），不要求重放整条 Elo/ts-fsrs 序列（ts-fsrs Card 重放确定性难保证 + 代价高）。
- 为什么不重放：owner 否决全序列重放。代价见 §诚实天花板（快照只能倒带到 attempt 前，不能「抽掉中间保留后续」）。

### 4. 级联 revert：recursive CTE 遍历器 + 反依赖序补偿 + 双路统一编排

- **`collectCascadeFromCheckpoint`**（`src/server/events/cascade.ts`，仓库首个 `WITH RECURSIVE`）：从 user_ask/chip checkpoint event 沿 caused_by 反向收下游。**陷阱**：correct 事件同时用 caused_by+subject_id 指回 target → 必须 `WHERE action <> 'correct'`（沿用 getEventChain:963 正解），否则补偿事件被当下游二次撤销。**护栏三件套**：cycle guard（path 数组）+ depth limit（硬顶 64 熔断）+ node cap（超限 truncated=true → 拒绝级联要求人工，不做半残）。
- **双路统一编排**（`src/server/revert/cascade-revert.ts`）：每 event 映射成 `RevertableEffect{kind:'structural_fold'|'state_snapshot', reversibility:'derived'|'entity'|'irreversible'}`。结构 effect → fold 重算（单点自动处理后续，ADR-0006 红利成立）；attempt effect → 快照恢复（强制级联倒带）。反拓扑序（depth DESC）同 tx 依次 revert，每个写各自补偿 CorrectEvent。
- **预检诚实拒绝**：任一 node irreversible 或 truncated → 整体拒绝 + 告知边界，不做半残级联。
- **冲突护栏**：恢复 before 前断言「当前态==快照 after」，不等 409 拒绝（防冲掉范围外更新）。

### 5. caused_by 一致性补全（级联正确性硬前置）

- 🟢 **`ctx.causedByEventId` 透传 = 已闭环（2026-06-15 grounding 修正，**降级：非硬前置**）**：原断言「durable copilot job 不透传 → caused_by=null」对着 M5 后代码证伪。`ToolContext.causedByEventId`（`src/server/ai/tools/types.ts:38`）存在；同步面 copilot chat（`chat.ts:929`，值=user_ask event id）+ **所有现有 durable job**（`quiz_gen.ts:418` / `sourcing.ts:329` / `coach_daily.ts:323` / `dreaming_nightly.ts:325` 全填 `causedByEventId: triggerEventId`）都已透传；mirror writer `mcp-bridge.ts:289` 从 `ctx.causedByEventId ?? null` 读。**结论**：透传机制 + 模式已就位，未来新建 copilot durable run handler 照 quiz_gen 工厂模式填即自动满足——「新 handler 跟既有模式」非「修已坏透传」，**不是独立前置、不高于 rename**。
- 🟡 **worker manifest 接线（真·残留缺口，但非功能阻断）**：worker 进程靠 `bootstrap.ts` 的 `CORE_TOOLS`（41 条 superset）兜底，未调 `registerCapabilityCopilotTools`（仅 `server/index.ts:43` app 进程调）。功能上 worker **不缺工具**（superset 含全部 26 manifest 工具），是 manifest 归属真相源对齐问题，非 reach 阻断。fix = `start-worker.ts` 加一行对齐 app（折进 #47 首发 lane）。
- 🟡 `update_artifact` 无 writeEvent：级联撤需恢复 v(n-1) html，靠 mirror args 链。
- ✅ artifact inline 写本不该带 caused_by（artifact 表无此列），因果走 mirrorEvent。

### 6. 分 Wave（与 copilot reach/endurance 并行）

| Wave | 内容 | 与 copilot 关系 |
|---|---|---|
| **Wave 0 试点** | mastery_state + material_fsrs_state 快照可逆 + cascade CTE 遍历器骨架（worker causedByEventId 透传**已闭环**，见 §5，**非本 Wave 前置**） | **与 reach/endurance 并行起跑** |
| **Wave 1** | knowledge + knowledge_edge 真 fold + genesis backfill + 补 #1 + ADR-0034 一致性闸 | 并行 |
| **Wave 2** | goal + mistake_variant + learning_item | 并行 |
| **Wave 3** | artifact + question_block.structured + 补 #2~#7 | **与 YUK-358 笔记域合流，不平行造两套 artifact 写契约** |
| 横切 | cascade CTE + 级联编排器（Wave 0 引入骨架各 wave 复用） | checkpoint 腿 gated 在本改造后 |

**Wave 0 选 θ̂/FSRS 非结构表**：单写者已就位 + invariant 审计已强制 + owner 已拍快照 + 兑现 gate②c（公式调参从 event 重算 p(L)）+ D17 推翻后慢热资产可恢复 + 解锁 judge_retraction 回滚。风险最低、依赖最少、收益最高。

### 7. 迁移 + gate
- A 类（θ̂/FSRS）：不需 genesis backfill（attempt/review 早只写 event），补快照算子即可。
- **item_calibration 例外（Codex P2 修正）**：**不**归 A 类——其行由 `runItemPriorBackfill`→`applyItemPrior` 直接 `insert`（`item_prior_backfill.ts:101-103` / `item-calibration.ts:28-42`），**非 attempt/review 事件派生**，无 canonical event 可 fold。若按 A 类跳过 backfill，`audit:projection` 会把现有 `b`/`confidence` 当 drift 或重建为空 → 砸 MFI/θ̂。落地：归 B 类做 genesis-event backfill（每行补 `experimental:genesis` 锚），或为 calibration 写专属 canonical event。
- B 类（结构表）：genesis-event backfill（每行补一条 **`experimental:genesis`**（非裸 `genesis`——见下方 Codex 实施输入）system event 让 fold 当前态==现状）。
- 双写期：写 projection + append event + 即时 `fold==projection` 校验，一致再切真相源。
- 新 `pnpm audit:projection`（仿 audit:schema）：全量 fold diff vs 现表，非空=drift fail，机器守门「事件=真相」。
- step9-invariant-audit 扩反向断言：A 类写者旁必须有 snapshot-event append。
- 切换铁律：knowledge → knowledge_edge（FK）；artifact 末位。

## Codex review 实施输入（2026-06-15，PR #416 · 11 条 P2）

**已就地修正（本批）**：① item_calibration 非 attempt/review 派生、须补 genesis backfill（§7 例外）；② §6 Wave 0 + §修正③ 的「worker causedByEventId 头号硬前置」与 §5「已闭环」对齐（删前置框定）；③ 设计 §226/§230 切换序统一为 knowledge→knowledge_edge；④ 设计 §166/§805 cascade CTE 外层包 `ORDER BY depth DESC`（DISTINCT ON 只能按 id 排，否则反依赖序落空）；⑤ 统一波次序 checkpoint 从 W6 移到 W7、排在全 projection 改造后。

**实施时硬要求（deferred 到对应 Wave，落地前不得遗漏）**：
1. **`experimental:state_snapshot` 专用 schema 校验**（设计 §550，Wave 0）：不能只靠通用 `ExperimentalEvent` fallback（只校 action 前缀 + payload 是 record）。须在 `writeEvent` 校验 `theta_snapshots[]`/`fsrs_snapshots[]` 形状 + before/after + cold-start null 语义——它是 θ̂/FSRS 回滚的唯一依据，少字段/拼错会持久化坏快照，到 revert 才暴雷。
2. **state_snapshot 跳过 memory outbox**（§3 + ADR §42，Wave 0）：同 tx `writeEvent` 若不显式 `ingest_at` opt-out，现有 outbox 会把每条快照送 `memory_event_ingest` → 完整 JSON 发 mem0 + 触发 brief regen。快照是内部回滚账本非学习者事实，每次作答多写 1KB+ 会持续污染记忆层 + 后台成本。设计钉死：snapshot event 写入跳过 memory ingest。
3. **knowledge 节点重放路径**（设计 §429，Wave 1）：accepted `propose_new`/`split` 的 knowledge 节点，**没有任何事件的 `(subject_kind, subject_id)` 等于新生成的 knowledge id**（propose event subject_id=proposal id，rate event subject_kind='event'）——即便 `materialized_ids` 写进 rate payload。增量 fold **不能**只用 `event_subject_idx` 拉「该实体全历史」，否则漏掉创建事件、重建不出节点。须建 knowledge id → 其 genesis/rate 事件的显式路径（如 materialized_ids 反查索引）。
4. **genesis/import 用 `experimental:` 前缀**（设计 §215，Wave 1/迁移）：裸 `genesis`/`import` action 会被 `writeEvent` parse barrier（只认 KnownEvent 或 `experimental:` 前缀）在迁移脚本第一条 backfill 就拒掉。须用 `experimental:genesis`/`experimental:import`，或新增 KnownEvent schema（`actor_kind='system'` + payload 契约）。
5. **question_block.structured genesis 不止迁移当下**（设计 §421，Wave 3）：canonical `extract` event 只存 `structured_block_ids`，真正的 structured/figures/page_spans 在 `applyExtractionResult` 直插表。对现有行做一次 genesis 只覆盖迁移当下；切换后新 OCR 产生的 block 仍无法从 event 重建 → 须扩 `extract` payload 带 block 内容，或为每个新 block 写 create/genesis 事件。
6. **`merge_questions` 多行 after 状态**（设计 §384，Wave 3）：`mergeQuestions` 不只改 primary 树——还把每个被合并 block 置 `status='ignored'` + 记 merged_into。canonical event 须覆盖**所有受影响 block 的 after 状态**（非只 primary after-tree），否则 fold 重建不出被合并 block 的状态变更，重放后这些块仍像 draft 可导入/编辑。

## 修正 ADR-0041（checkpoint 腿，劈成两半不推翻）
见独立 amendment（同批提交）：①「派生重算红利」→「event-sourced 重算（结构）+ 快照恢复（θ̂/FSRS）混合」；②级联遍历器是硬前置非既有能力（YUK-363 Wave 0 引入）；③ ~~worker causedByEventId 透传是头号硬前置~~ **已闭环（§5 grounding 修正：同步面 + 所有现有 durable job 已透传，非前置）**；④诚实天花板：per-utterance 窗口内级联几乎总干净，跨 turn 触及已练 attempt 部分不可逆。

## 诚实天花板
- **纯派生 projection**（树/边/mastery view/artifact 内容/structured）→ ✅ 干净撤（fold 重算）。
- **实体行（带乐观锁）**（artifact/knowledge/practice_stream_item）→ ✅ 软删（archived_at）。
- **既成事实**（真 attempt/review 事件 + FSRS 入册 + user_verified 块）→ ❌ 撤不掉（retract = 篡改用户真实行为历史）。题进 frontier(排入)可撤；真 attempt 不可撤。
- **θ̂/FSRS 快照只能倒带到 attempt 前，不能「抽掉中间一次保留后续」**——跨 turn 撤中间 attempt 必须级联 retract 其后所有同 subject attempt（倒带式），否则不可逆。owner 否决重放 → 这是诚实代价非 bug。
- **per-utterance 窗口**：turn 内（刚说完未练）几乎总干净；窗口越久不可逆下游越多。这是 checkpoint 腿的物理边界，非实现缺陷。

## 备选（已否决）
- **checkpoint 降级 MVP**（不改地基，revert 只覆盖可逆子集 + 软隐）——owner 否决，要真 event-sourced。
- **θ̂/FSRS 全序列重放**——owner 否决（ts-fsrs Card 重放确定性难保证 + 每 attempt 重放代价高）。
- **读时 fold（不物化）**——否决（结构表高频读 + join，读时重放全历史不可接受）。
- **artifact 与 YUK-358 平行各造写契约**——否决（Wave 3 合流，不造两套）。
