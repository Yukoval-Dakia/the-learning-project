# Phase 2B Learning Intent Orchestrator — Brainstorm + Scope Fence

**状态**：scope-fixing brainstorm（落代码前先收缩范围，避免飘）
**spec 来源**：`docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §"Phase 2B"
**模块依赖**：`docs/modules/learning-items.md` §1.2 §3 + `docs/modules/notes.md` §1-§4 §6 §8
**前置已落地**：Phase 1c.2（learning-item 6 状态机）+ commit `ac4d4e3`（hub+atomic 层级 UI）+ Phase 2A（Review Orchestrator 模式样板）

---

## 一句话目标

用户在 `/learning-items` 顶上输入「我想学 X」→ orchestrator 读知识图谱 / 提议 hub+atomic 拆分 / 用户审 / 接受后异步生成 N 个 atomic note → 用户在 `/learning-items/[hub-id]` 看 hub 摘要、点入每个 atomic 看完整 note + 嵌入式自检占位 → self_declare 完成。

---

## 必须做的（MVP scope）

| 件 | 备注 |
|---|---|
| 1 个新 endpoint：`POST /api/learning-intents` | body `{ topic: string }`；调 `planLearningIntent(topic)` LLM 一次；返回 `{ hub_proposal, atomic_proposals[], knowledge_node_id? }` 让用户审 |
| 1 个新 endpoint：`POST /api/learning-intents/[id]/accept` | 接受 proposal → 同事务建 1 hub LearningItem + N atomic LearningItems + N 占位 artifact rows + 入队 N 个 `note_generate` pg-boss job |
| 2 个新 task in registry：`LearningIntentOutlineTask` + `NoteGenerateTask` | 两个都 xiaomi/mimo-v2.5-pro；前者出 outline JSON；后者出 markdown sections JSON |
| 1 个新 pg-boss handler：`note_generate` | 一 atomic 一 job；调 NoteGenerateTask；UPDATE artifact.sections + generation_status |
| schema 改：`artifact` 表 | 之前是 stub；本次激活 `sections jsonb`、`type text`、`generation_status text` 字段写路径；不加新表，复用现有 schema |
| UI 改：`/learning-items` | 顶上加 "我想学..." 输入框 + 提交 → 跳到 `/learning-intents/[id]` 审核页 |
| UI 新：`/learning-intents/[id]` 审核页 | 显示 hub_proposal + atomic_proposals 列表；accept / dismiss 按钮；accept 后跳回 `/learning-items/[hub-id]` |
| UI 改：`/learning-items/[id]` 详情页 | 当 `primary_artifact_id` 有值时，fetch artifact 显示 sections（definition / mechanism / example / pitfall / check） |
| Tests | unit: planLearningIntent + 2 task parsers + accept handler；route: 3 个 endpoint；E2E: 容器实测一次 "我想学 X" 全链路 |

---

## **绝对不做** 的（防漂移清单）

| 概念 | 为何延后 | 留给 |
|---|---|---|
| `NoteVerifyTask`（双 pass 反幻觉） | spec 标 Phase 2 二档；MVP 接受单 pass + LLM-only `source_tier` | Phase 2.5 |
| Search-grounded note | 依赖 `SourcePack` schema；Phase 2.5 起步 | Phase 2.5 |
| Living note 触发器 | 依赖 dreaming worker；本期不动 | Phase 2 dreaming agent |
| `source_tier` 4 等级 + per-section `user_verified` | 多一个 field 一组 UI；MVP 全部默认 `llm_only`, `false` | Phase 2.5 |
| TipTap 编辑器 | 阅读优先；编辑能力不在 Phase 2B 完成标准 | Phase 2/3 UI iteration |
| Embedded check 真跑 quiz 引擎 | 依赖 `JudgeRouter` + quiz module；本期占位显示 question_ids 数量 + "Phase 3 启用" | Phase 3 quiz module |
| Hub status 自动聚合 children | 需要 trigger 或 derived view；用户手动改 hub 状态足够 MVP | Phase 1d/2 |
| 知识图谱新节点 propose（spec §8 case 3a/3b） | 复杂度大，需要走 propose+accept 流程；MVP **只支持 case 3c**（topic 节点 + 子节点已存在；不存在则 422 + 提示用户先去 /knowledge 建） | Phase 2B+ |
| 完成路径 `ai_propose` + `quiz_pass` | 依赖 dreaming + quiz；MVP 只跑 `self_declare` | Phase 2/3 |
| `~/.learning-project/notes/` 文件系统存储（spec §10.3） | 容器内文件系统不便迁移；先用 `artifact.sections jsonb` 落库 | Phase 3/4（要让用户能 Obsidian 打开时再说）|
| 「在 atomic note 上停留很久」之类用户行为追踪 | StudyLog 不在本期 scope | Phase 2C+ |
| 优先级 score 公式 4 维加权 | 已分另一项；MVP 用现有按 status + updated_at | Phase 1d/2 |

---

## 数据流（同事务 / 异步分界）

```
[同事务] POST /api/learning-intents
  → planLearningIntent(topic)  ← LLM #1（mimo, ~10s）
  → return { proposal_id, hub: {...}, atomics: [...], knowledge_node_id }
  → 持久化：暂不写 LearningItem / artifact；只写一条 propose event 占位（actor=user/self, action='propose', subject_kind='learning_item'）
    - payload: { topic, hub_outline, atomic_outline }
    - 用 event.id 当 proposal_id

[同事务] POST /api/learning-intents/[id]/accept
  → 读 propose event
  → DB transaction:
     - INSERT learning_item × (1 hub + N atomic)，parent 关联好
     - INSERT artifact × (1 hub + N atomic)，generation_status='pending', sections=[] 占位
     - UPDATE LearningItem.primary_artifact_id ← 对应 artifact.id
     - INSERT rate event(action='rate', subject_id=proposal_id, payload.rating='accept')
  → 出 transaction 后:
     - enqueue pg-boss note_generate × N（一 atomic 一 job）
     - 一 job 单独 generate 一个 hub 的 outline-only 短 note（同步在 transaction 里也可，但慢；放异步好）
  → return { hub_learning_item_id, atomic_learning_item_ids[] }

[异步] worker handles note_generate(atomic_artifact_id)
  → 读 artifact + 关联 LearningItem + parent_artifact_id (hub) 上下文
  → NoteGenerateTask(input) ← LLM #2..N（mimo, 一个 atomic ~30-60s）
  → parse 出 sections[]
  → UPDATE artifact SET sections=..., generation_status='ready'
```

---

## Scope-fence 自检：每写一行都问

1. **这一行做的事在 §"必须做的" 里吗？** —— 不在就停
2. **这一行依赖 §"绝对不做"清单里的概念吗？** —— 依赖就 stub / 跳过
3. **这一行能复用现有 `parent_learning_item_id` / `artifact.sections` / `event(action='propose')` 路径吗？** —— 能就用，别新加表
4. **schema 改动只限激活 `artifact` 写路径** —— 不新加表、不改 enum constraint、不动 fsrs / mistake / knowledge

---

## 5 个最容易飘的地方（提前防）

1. **写到一半要"顺手"做 `NoteVerifyTask`** —— 不做。MVP 单 pass，sections 全标 `llm_only`，用户看到知道是低可信。
2. **想让 hub 也调 NoteGenerateTask 生成完整 sections** —— 不做。Hub 只要一个 1-2 句话的 outline 摘要（spec §4 "Hub outline + 第一节"，hub 摘要本身放 accept 同事务里，秒出）。
3. **想要 Embedded check 真的跑** —— 不做。`sections.check.question_ids` 占位即可；点 check section 显示 "embedded check Phase 3 启用"。
4. **想加 `source_tier` field 因为 spec 提了** —— 不加。spec 标的是 Phase 2.5。
5. **想做 knowledge_node propose** —— 不做。case 3a/3b 全部转化成 422 错误 + "请先去 /knowledge 创建节点 + 子节点" 引导。MVP **仅支持 case 3c**。

---

## 完成标准（DoD）

- `pnpm test` 全过（新 N 个测试，不破现有 794）
- `pnpm typecheck` / `pnpm lint` 干净
- E2E：在容器里跑一次「我想学'文言文虚词之的用法'」（topic 节点 + 子节点已 seed 进 knowledge tree）→ accept → 等 1-2 min → 在 `/learning-items/[hub-id]` 看到 N atomic 卡片，每个点入看到生成的 markdown sections
- doc 更新：本 brainstorm + `modules/learning-items.md` § 0 + `modules/notes.md` § 0 + 新 plan doc 写状态
- 不打开任何 spec 明确推到 Phase 2.5+ 的盒子

---

## 任务拆解（执行用）

按依赖排序，每步一个 commit：

1. **schema**：检查 `artifact` 表是否已有 `sections jsonb` / `type text` / `generation_status text` / `parent_artifact_id`；缺啥补啥；写 migration
2. **registry**：注册 LearningIntentOutlineTask + NoteGenerateTask（system prompts 严格按 spec §3 五种 section + §7.1 LLM-only 默认）
3. **orchestrator module**：`src/server/orchestrator/learning_intent.ts` —— planLearningIntent(topic) + acceptLearningIntent(proposalId)
4. **pg-boss handler**：`src/server/boss/handlers/note_generate.ts` + 注册队列
5. **routes**：`POST /api/learning-intents` + `POST /api/learning-intents/[id]/accept` + tests
6. **UI**：`/learning-items` 顶上输入框 + `/learning-intents/[id]` 审核页 + `/learning-items/[id]` 显示 sections（当 artifact ready）
7. **container E2E**：build + redeploy + 真跑一遍 + screenshot
