# Phase 1a 设计 — 知识图谱 + 录入闭环 + AI agency 起作用

> 本 spec 是 Phase 1a 的 master design。Sub 1 详细设计已 lock，可直接进 writing-plans。Sub 2-5 仅概览，做到时再单独 brainstorm。

**Goal**：5-7 天 MVP 目标因「AI 全编辑 tree」扩展到 **9-10 天**，完成"自己能用它备文言文一周、跑出第一批数据"的闭环 + AI agency 从 day 1 起就生效。

**Spec reference**: `docs/superpowers/specs/2026-05-08-phase1-improvements-design.md` 改进 3（PLANNING 拆 1a/1b）

---

## 一、总体决策

| 决策 | 选项 | 理由 |
|---|---|---|
| 知识点 tree 来源 | 薄 seed（7 顶级）+ AI expand | AI agency 优先，但留 anchor 防 AI 凭空乱建 |
| AI 编辑 tree 范围 | 全上：propose_new / reparent / merge / split / archive | 用户明示「应该可以由 AI 完成」 |
| domain 字段处理 | NULLABLE + inherit from parent | 支持跨 domain reparent（"文言文挂语文下"）；schema migration 必须 |
| 触发时机 | 录入 inline `propose_new` + 手动按钮 batch full | cron 推 Phase 2 Dreaming task |
| Mutation 工作流 | 写 `dreaming_proposal` 表（已存在）+ user 审批 | 无需新表，复用 existing schema |

---

## 二、5 sub-projects 概览

| Sub | 内容 | 估时 | PR 拆分 |
|---|---|---|---|
| 1. 知识图谱 | schema migration + 薄 seed + AI propose-new (inline def) + AI batch review + approval workflow + 2 UI | ~5 天 | 2 PR (A/B) |
| 2. 录入基础 | 录入页（粘贴 + dropdown + cause manual）+ /api/mistakes POST + wire Sub 1 inline propose | 1.5 天 | 1 PR |
| 3. AttributionTask AI 接通 | LLM 自动归因 + 失败兜底队列 + 录入页接 AI auto-fill cause | 1.5 天 | 1 PR |
| 4. 复习闭环 | ts-fsrs 包装 + 复习队列 + 复习 UI + LearningItem 三态 + 完成判定 + Evidence 表单 | 2 天 | 1-2 PR |
| 5. 数据导出 | JSON / Markdown 全量导出 | 0.5 天 | 1 PR |

**总计 ~9.5 天** | **总 PR ~6-7 个**

---

## 三、Sub 1 详细设计：知识图谱

### 3.1 Schema migration

**改动**：`knowledge.domain` 从 NOT NULL → NULLABLE。

**Invariant**（apply / mutation 逻辑都要守）：
- `parent_id IS NULL` ↔ `domain IS NOT NULL`（root 节点必须有 domain）
- `parent_id IS NOT NULL` ↔ `domain IS NULL`（非 root 节点 domain 永远走 inherit）

**helper（worker + client 各一份或共享）**：
```ts
async function getEffectiveDomain(db, nodeId): Promise<string> {
  let cur = await db.select(...).where(eq(knowledge.id, nodeId)).limit(1);
  while (cur.parent_id) {
    cur = await db.select(...).where(eq(knowledge.id, cur.parent_id));
  }
  return cur.domain; // root 必有 domain
}
```

`GET /api/knowledge` response 中所有 node 都附 `effective_domain` 字段（query 时 walk up 一次性算）。

**migration 文件**：`drizzle/0001_*.sql`，含 `ALTER TABLE knowledge ALTER COLUMN domain DROP NOT NULL`。

### 3.2 薄 seed

`src/subjects/wenyan/curriculum.json`（已存在但空）填：

```json
{
  "version": 1,
  "domain": "wenyan",
  "knowledge_seeds": [
    {"name": "实词", "slug": "shici"},
    {"name": "虚词", "slug": "xuci"},
    {"name": "句式", "slug": "jushi"},
    {"name": "断句", "slug": "duanju"},
    {"name": "翻译", "slug": "fanyi"},
    {"name": "文学常识", "slug": "wenxue-changshi"},
    {"name": "论述题", "slug": "lunshu"}
  ]
}
```

**`seedKnowledge(db)` runner**：
- idempotent — 检查每个 slug 已 exist 跳过
- 每个 seed 写 row：`{id: cuid2(), name, domain: 'wenyan', parent_id: null, proposed_by_ai: false, approval_status: 'approved', ...}`
- 触发方式：worker 的 `/api/_/seed` POST endpoint（手动触发，避免 boot-time 副作用）

### 3.3 5 类 mutation kind

写入 `dreaming_proposal.kind` + `dreaming_proposal.payload` JSON：

| Kind | Payload | Apply 逻辑 |
|---|---|---|
| `propose_new` | `{name, parent_id, reasoning}` | INSERT knowledge（status=approved）|
| `reparent` | `{node_id, new_parent_id, expected_version}` | UPDATE parent_id; 若 root 变非 root 把 domain set NULL；若非 root 变 root 报错（必须 user 明指 domain）|
| `merge` | `{from_ids[], into_id, expected_versions{}}` | from_ids 全 archive + push into.merged_from + 把所有引用 from_ids 的 mistake/question 的 knowledge_ids 重挂到 into_id |
| `split` | `{from_id, into[]: {name, parent_id}, expected_version}` | from_id archive + insert N 个新；mistake/question.knowledge_ids 仍指向 archived from_id（不强制重挂）；mistake 详情页 UI 显示「该 tag 已 split」提示 + 可选重挂到 split 子（用户手动）|
| `archive` | `{node_id, expected_version}` | set archived_at（不删，保留历史）|

**乐观锁**：每个 mutation payload 含 `expected_version`，apply 时若不匹配，proposal status='stale'，前端展示"已过期，需 AI 重新 propose"。

**跨 domain reparent**：reparent 把节点从 root 变为 child 时，domain set NULL（inherit 接管）。前端 review UI 显示"将影响 N 条 mistake/question 的 effective_domain"作 warning，user 可看实际影响范围再 approve。

### 3.4 AI Tasks

#### KnowledgeProposeTask（inline，Sub 2 在 /api/mistakes POST 后调）

```
input: {
  mistake_content: { wrong_answer, reference, knowledge_ids_picked: string[] },
  tree_snapshot: KnowledgeNode[]  // 全 tree（薄 seed + 已 approved 的 AI 提议）
}
output: { proposals: ProposeNewPayload[] }  // 0-3 条
```

**Prompt 简述**：「看这条 mistake，挂的 knowledge_ids 是 user 自选。如果你认为 tree 里缺一个**更精确**的子节点能挂这条 mistake（如「之-主谓间用法」之于「虚词」），propose 它。0-3 条，不必凑数。」

**写出**：每条 → `dreaming_proposal {kind: 'propose_new', payload, reasoning, status: 'pending'}`

**失败兜底**：error 不阻塞 mistake 创建。仅 `cost_ledger` 记一条 + Worker log。

#### KnowledgeReviewTask（手动按钮触发）

```
input: {
  full_tree: KnowledgeNode[],
  recent_mistakes: Mistake[]  // 最近 N 条（N=100 起）
}
output: { proposals: AnyMutationPayload[] }  // N 条
```

**Prompt 简述**：「看完整 tree + 最近的 mistake 数据，propose 任意 mutation 让 tree 更合理：合并冗余、拆解过粗、reparent 错位的、archive 没被使用的。」

**streaming**：上下文大、输出多，用 `streamTask`（PR 2 已 ship 模式）。`needsToolCall: true`。

**写出**：每条 mutation → `dreaming_proposal` row，user 在 UI 一条条审。

### 3.5 Server APIs

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/knowledge` | 全 tree（含 effective_domain） |
| POST | `/api/_/seed` | 触发 seedKnowledge（idempotent） |
| GET | `/api/knowledge/proposals?status=pending` | 列 pending mutations |
| POST | `/api/knowledge/proposals/:id/decide` | body `{decision: approve\|reject}` |
| POST | `/api/knowledge/review` | 触发 KnowledgeReviewTask（streaming response） |

所有都受 `internalAuth` middleware 保护（已存在）。

### 3.6 Approval engine

`approveProposal(db, proposalId)`：
1. SELECT proposal，确认 status='pending'，否则返 409
2. switch on `kind` 调对应 apply 函数
3. apply 内部用 `version` 字段做 optimistic lock（`UPDATE ... WHERE version = ?`）
4. 若 0 行 affected：proposal 设 status='stale'，返 409「请重新让 AI propose」
5. 否则：proposal 设 status='approved' + decided_at

`rejectProposal(db, proposalId)`：直接 status='rejected' + decided_at。

### 3.7 UI 表面

#### `/knowledge` — Tree explorer（read-only PR A，可编辑入口 PR B）
- 简陋表格：id / name / parent_name / effective_domain / proposed_by_ai / pending_proposal_count
- Tree 视图（缩进表示层级），无拖拽
- 顶部按钮："AI review my tree" → POST /api/knowledge/review，watch streaming 进度

#### `/knowledge/proposals` — Pending review
- 列表，每条显示：kind / payload preview / reasoning / proposed_at
- 每条 [Approve] [Reject] 按钮
- approve 失败（stale）显 toast + 自动 hide

#### 不进主导航
- 同 `/_/inspect`，URL 直访
- `/_/inspect` 加一行 link 到 `/knowledge` 和 `/knowledge/proposals`

### 3.8 失败兜底

| 失败点 | 行为 |
|---|---|
| `KnowledgeProposeTask` LLM 失败 | mistake 仍创建。Worker log + cost_ledger。 |
| `KnowledgeReviewTask` LLM 失败 | UI 报 toast。无 dreaming_proposal 写入。 |
| `approveProposal` version mismatch | proposal 设 stale。UI 提示「已过期，需 AI 重新 propose」 |
| `seedKnowledge` 部分失败 | idempotent，下次重跑 |

### 3.9 Sub 1 PR 拆分

**Sub 1 PR A**（~3 天）—— 基础 + propose_new only：
- Schema migration (`drizzle/0001_*.sql`)
- `getEffectiveDomain` helper + tests
- curriculum.json 填实 + `seedKnowledge` runner + tests
- `POST /api/_/seed` endpoint
- `GET /api/knowledge` endpoint
- `KnowledgeProposeTask` task def + registry 注册（Sub 2 来 wire inline）
- `dreaming_proposal` 写入 helper
- `GET /api/knowledge/proposals`
- `POST /api/knowledge/proposals/:id/decide` —— PR A 仅支持 `propose_new` apply
- `/knowledge` UI（read-only）
- `/knowledge/proposals` UI（仅显示 propose_new + approve/reject）

**Sub 1 PR B**（~2 天）—— 高阶 mutation：
- `reparent` / `merge` / `split` / `archive` apply 函数 + tests
- `KnowledgeReviewTask` task def + streaming wire
- `POST /api/knowledge/review` trigger endpoint
- `/knowledge/proposals` UI 扩展，显示 4 类高阶 mutation 的 payload preview + reasoning
- `/knowledge` UI 顶部 "AI review my tree" 按钮 + 进度展示
- 跨 domain reparent warning（"将影响 N 条 mistake"）

---

## 四、Sub 2-5 概览（实施前各自再 brainstorm）

### Sub 2: 录入基础（1 PR，1.5 天）
- 录入页：粘贴题面 / 参考答案 / 错答 / 知识点 multi-select dropdown（来自 GET /api/knowledge）/ cause manual dropdown（10 类）
- `POST /api/mistakes`：建 question + mistake 行（一个事务）；POST 完成后调 `KnowledgeProposeTask` inline（不阻塞 response）

### Sub 3: AttributionTask AI 接通（1 PR，1.5 天）
- `AttributionTask` 调 LLM 输出 `cause`，写 mistake.cause
- 失败兜底：mistake.cause 留空 + 写"待人工归因"队列（用 dreaming_proposal kind='attribution_pending' 或独立 mistake 字段；定 Sub 3 brainstorm 时）
- 录入页接：cause dropdown 显示 "AI 自动" 选项，POST 时 cause 留空，AttributionTask 跑完写回；前端 polling 或重 fetch mistake 看到 cause 后展示

### Sub 4: 复习闭环（1-2 PR，2 天）
- `ts-fsrs` OSS 包装：FSRS state 存 `mistake.fsrs_state` json
- `LearningItem` 三态状态机：pending / in_progress / done
- 复习队列：`GET /api/review/due`
- 复习 UI：显示 mistake → user 自评对错 → next 调度
- 完成判定：自我宣告 button（pending → in_progress → done）+ Evidence 表单（写 completion_evidence 表）

### Sub 5: 数据导出（1 PR，0.5 天）
- `GET /api/export?format=json|markdown`
- 全量 dump knowledge / question / mistake / learning_item / study_log / completion_evidence

---

## 五、决策汇总（备查）

- **粒度**：薄 seed（7 顶级）+ AI expand
- **AI 编辑 tree 范围**：全上 5 类 mutation
- **domain**：NULLABLE + inherit from parent
- **触发**：录入 inline `propose_new` + 手动 button batch
- **审批模型**：`dreaming_proposal` 表（已存在）+ user UI 一条条审
- **乐观锁**：每个 mutation 含 expected_version
- **失败兜底**：AI 失败不阻塞 mistake 创建
- **PR 边界**：Sub 1 拆 2 PR（A=基础+propose_new，B=高阶 mutation）
- **总估时**：9-10 天，6-7 个 PR

---

## 六、Open（实施前再决）

- KnowledgeReviewTask 输入用最近 N 条 mistakes，N 怎么定？固定 100 / 最近 7 天 / 全部？建议 100 条起手，跑过看 token 量再调。
- `split` mistake 重挂决策：spec 选了「不自动 + UI 提示」 — 跟 merge 自动重挂不一致是有理由的（merge 1:1 映射可推断；split 1:N 不可推断）。如果实际跑下来发现「孤儿引用 archived」太多，PR B 末尾加批量重挂工具。
- knowledge.approval_status vs dreaming_proposal.status 都用 'approved'/'pending'/'rejected' 命名 — spec 里清晰区分：前者是 node 自身审批状态（user 直接编辑 OK），后者是 mutation 提议生命周期（一旦 apply 不可改）。代码层面无 join，无歧义。
- `getEffectiveDomain` worker / client 是否共享 helper？建议先 worker 独写，client 在 GET /api/knowledge response 里直接拿；PR A 末尾如果有 dup 再共享。
- `/api/_/seed` 是否要参数化（多 domain 多 curriculum）？Phase 1a 单 domain，先固定 wenyan；多 domain 推 Phase 2。
