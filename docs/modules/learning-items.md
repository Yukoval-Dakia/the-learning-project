# 待学习列表（LearningItem）

> 见 [架构基础](../architecture.md) 了解 `learning_item` / `completion_evidence` schema。
> Quiz 通过路径详见 [`quiz.md`](quiz.md)。
> 学习意图触发的 note 生成详见 [`notes.md`](notes.md)。

新一等公民——不是错题、不是知识点、不是复习队列，是「还没学 / 不熟，要去做」的项。

---

## 0. 实施现状（2026-05-17）

> 下面 §1–§N 是 Phase 1 sketch 期写的。**当前实际**已兑现 schema + 6 状态机 + 知识点关联 + 完成 evidence 自我宣告 + hub+atomic 结构性 UI；高级特性（dreaming 集成 / 优先级 score / note 联动）都在 Phase 2 / Phase 1d。读完本节心里替换即可。

| 设计概念 | 已落地 | 备注 |
|---|---|---|
| `learning_item` 表 + `completion_evidence` 表 | ✅ schema | 1c.1 已存在 |
| 6 状态机 `pending / in_progress / done / dismissed / resting / archived` | ✅ Phase 1c.2 Cand 2 落定（commit `7fb58e0`） | 转换矩阵 + UI tabs + revival 流程 |
| `knowledge_ids` 关联 + UI 显示 | ✅ Phase 1c.2 commit `dd50a3a` | 创建 + per-row "改知识点" 内联编辑 |
| `parent_learning_item_id` / `child_learning_item_ids[]`（hub+atomic 层级） | ✅ Phase 1d commit `ac4d4e3` | GET /api/learning-items/[id] 返 parent + children；PATCH 支持 set/clear parent（cycle prevention）；POST 接 optional parent；/learning-items/[id] 详情页 inline 编辑 + parent breadcrumb + children list + parent picker。**派生约定**：有子项 = hub，没子项 = atomic；不引入 `kind` enum |
| 优先级 score 公式（urgency·0.4 / weakness·0.3 / recency·0.3 / pin） | ❌ 现按 status + updated_at 排序 | Phase 1d |
| AI 主动提议完成（DreamingProposal.kind='learning_item_completion'） | ❌ | Phase 2 dreaming worker |
| 复学机制（done → resting → propose relearn） | ⚠️ resting 状态在；触发链未接 | Phase 2 |
| Note artifact 联动（hub ↔ note_hub 1:1; atomic ↔ note_atomic 1:1） | ❌ | Phase 2B Learning Intent Orchestrator |
| 4 个来源（quiz_answer / manual / note_gen / dreaming） | ⚠️ 现只跑 `manual` 一个 source；`learning_intent` 入口 Phase 2B 加 | quiz_answer 等 Phase 2 |

**当前 UI 入口**：
- `/learning-items` — 创建 + 6 状态切换 + knowledge_ids 编辑 + 软删除 + title 跳转 detail
- `/learning-items/[id]` — 内联编辑 + 状态转移 + parent breadcrumb + children list + parent picker（hub/atomic 层级 read+write）

---

## 1. 四种来源 + 层级化

### 1.1 4 个来源

```
错题归因后        ─┐
主动输入          ─┤
学习意图声明      ─┼→ 待学习列表 (LearningItem)
AI dreaming 推荐  ─┘   (dreaming 来源经待审核区)
```

| 来源 | 触发 | 拆分形态 |
| --- | --- | --- |
| `mistake` | 归因发现缺口 | 1 atomic（无 hub） |
| `manual` | 用户手动加 | 默认 1 atomic；用户可手动嵌套 |
| `learning_intent` | 用户声明 "我想学 X" | **1 hub + N atomic**（同步触发 NoteGenerateTask 时一起创建） |
| `ai_dream` | dreaming 主动 propose | 默认 1 atomic（先进待审核区） |

### 1.2 层级化（hub + atomic LearningItems）

学习意图（"我想学氧化还原反应"）会触发 `NoteGenerateTask` 产生 1 hub + N atomic notes。每个 note 配套一个 LearningItem：

```
LearningItem (hub, source=learning_intent)
  primary_artifact_id → note_hub
  parent_learning_item_id = null
  child_learning_item_ids = [atomic_li_1, atomic_li_2, ...]
  status 自动聚合自 children
  ↓
LearningItem (atomic) × N
  parent_learning_item_id → hub LearningItem id
  primary_artifact_id → note_atomic_i
  独立完成判定
```

**UI**：
- todo 列表默认显示 atomic（具体可做的项）
- 切换"按主题分组"时折叠到 hub
- hub LearningItem 不在 flat todo 列表占位（避免膨胀）；hub 主要用于聚合和导航

### 1.3 hub status 自动聚合

```
所有 children = pending                    → hub = pending
任一 child = in_progress                    → hub = in_progress
所有 children = done                         → hub = done
所有 children ∈ {done, dismissed}            → hub = done
   且至少有一个 done（dismissed 不阻塞 hub 完成）
所有 children = archived                    → hub = archived
```

---

## 2. 状态机（6 状态）

### 2.1 状态语义

| 状态 | 用户意图 | UI 可见 | 触发 |
| --- | --- | --- | --- |
| `pending` | 计划学但未开始 | todo 列表 | 创建时 |
| `in_progress` | 学习中 | todo 列表 | 用户标开始 / 开始消费 artifact |
| `done` | 完成（多路径判定通过） | "已完成"页 | quiz_pass / self_declare / ai_propose |
| `resting` | 完成后维持掌握中 | 统计页可见，不在 todo | done 一段时间后默认转入 |
| `dismissed` | 用户主动放弃 | 隐藏，可恢复 | 用户主动操作 |
| `archived` | 久未触达自动归档 | 隐藏，可恢复 | 90 天 maintenance propose + 用户接受 |

### 2.2 状态转换

```
pending → in_progress    (用户开始 / 消费 artifact)
in_progress → done        (多路径判定通过)
in_progress → pending     (用户暂停)
in_progress → dismissed   (用户主动放弃)
done → resting             (默认；保留可见但不催)
resting → pending          (用户主动重学 / dreaming propose 重学)
任意 → archived            (90 天未触达，maintenance propose)
任意 → deleted             (用户删，soft delete 30 天)
archived → pending         (用户主动 unarchive)
```

### 2.3 "复学"机制

`done → resting` 后 mastery 仍在衰减（FSRS retrievability 自然下降）。当 mastery 衰减到 < 0.5 持续 N 天，dreaming 主动 propose"重学这个项目？"。

```
DreamingProposal {
  kind: 'learning_item_relearn',
  payload: { learning_item_id, current_mastery, peak_mastery, days_since_done },
  reasoning: "{name} mastery 从 0.85 衰减到 0.45，建议重学"
}
```

用户接受 → `status` 回到 `pending`。

---

## 3. 完成判定（多路径）

不强制 quiz 才能 done。三条路径都接受：

| 路径 | 触发 | AI 角色 |
| --- | --- | --- |
| 用户自我宣告 | 用户点「完成」 | 看证据：足则 done；不足时**软反问** + **保留强制覆盖**（强制时 evidence_json 标 `user_overrode_low_evidence`） |
| AI 主动提议 | 满足任一：mastery>0.8 持续 14 天 ∨ 关联 check 全过 ∨ 该知识点 7 天错 0 | 走 DreamingProposal 路径，详见 § 3.2 |
| Quiz 通过 | 用户选择走严格路径 | 出题 + 评分（详见 [`quiz.md`](quiz.md)）；通过 = 所有关联 Question 的 effective Judgment.verdict==correct，base mastery 硬跳升到 ≥ 0.7 |

### 3.1 自我宣告路径的"软反问"

用户点完成时 AI 检查 evidence：
- 充足 → 直接 done
- 不足 → 弹"我注意到你最近还没怎么练这块，要做个 quick check 吗？" + 保留"我就是会了"强制按钮
- 强制完成 → evidence_json 标 `user_overrode_low_evidence: true`（留痕）

### 3.2 AI 主动提议路径的 UX

dreaming 夜间扫描产出 `DreamingProposal`，类型 `learning_item_completion`：

```
DreamingProposal {
  kind: 'learning_item_completion',
  payload: {
    learning_item_id,
    triggering_signals: ['mastery_high_persisted_14d' | 'check_all_passed' | 'no_mistake_7d'],
    evidence_summary: { ... }
  },
  reasoning: "我觉得你已掌握【XXX】，确认完成？"
}
```

进 dreaming 待审核区。用户次日打开 app 看到通知 → 一键 approve / dismiss：
- approve → 创建 `CompletionEvidence(path=ai_propose)` + `LearningItem.status='done'`
- dismiss → 该 LearningItem 短期内（默认 7 天）AI 不再提议同一项

### 3.3 CompletionEvidence

所有路径都产生 `CompletionEvidence` 记录。每条 evidence 包含：
- 触发路径（`self_declare` / `ai_propose` / `quiz_pass`）
- `evidence_json`：AI 看到的信号快照
  - 近期错题正确率
  - 复习按时率
  - artifact 触达情况
  - 对话痕迹（提到该知识点的次数与上下文）
  - quiz_pass 路径下：所关联 Question 的 Judgment 列表
- `user_overrode_low_evidence?`: 仅 self_declare 强制覆盖时为 true
- `decided_at`

可回放、可质疑。三个月后能问"为什么当时判 done"，看 evidence 即可。

---

## 4. 优先级 score 公式

UI 默认按 score 降序排，user_pin 永远置顶。

```
score = w_urgency × urgency 
      + w_weakness × weakness
      + w_recency × recency

urgency  = max(0, 1 - days_until_due / 7)        # due 临近 7 天拉满，无 due 为 0
weakness = 1 - avg_mastery_of_related_knowledge   # 知识点越弱越优先
recency  = min(1, recent_related_mistakes / 5)    # 最近 7 天该相关错题数 (截顶 1.0)

默认权重:
  w_urgency  = 0.4
  w_weakness = 0.3
  w_recency  = 0.3

特殊规则:
  user_pinned=true       → 永远置顶 (boost 优先于 score)
  archived / dismissed   → 不进 score 排序
  hub LearningItem        → 不参与排序（不在 flat 列表）
  resting                 → 不参与（在统计页另显示）
```

权重 Phase 2 跑数据后调。

---

## 5. 与其他模块的接口

| 接口 | 方向 | 说明 |
| --- | --- | --- |
| 错题触发 LearningItem | mistake → learning-items | mastery<0.3 或近期反复错 |
| 学习意图触发 LearningItem 层级 | user → learning-items + notes | 1 hub + N atomic 同步创建，对应 note 层级 |
| `quiz_pass` 路径 | learning-item → quiz | 通过则 base mastery 硬跳升 |
| 完成时硬跳 base mastery | learning-item → progress | quiz_pass 路径触发 |
| 关联 primary_artifact_id | learning-item ↔ notes / quiz | 主消费物绑定 |
| AI 主动提议完成 | dreaming → learning-items | DreamingProposal.kind=learning_item_completion |
| AI 主动提议重学 | dreaming → learning-items | DreamingProposal.kind=learning_item_relearn |
| Maintenance: 归档 / 删除 | maintenance → learning-items | 90 天未触达 / 用户主动 |
| LearningRecord 关联 | learning-items ← records/progress | reflection / open_question / insight 可挂 LearningItem |

---

## 6. Schema

`LearningItem` / `CompletionEvidence` 详见 [架构基础 § 七](../architecture.md#七数据模型骨架)。关键字段：

```
LearningItem
  parent_learning_item_id?       # 层级：atomic 指向 hub
  child_learning_item_ids[]?     # 层级：hub 持有 atomic
  status: pending | in_progress | done | dismissed | resting | archived
  completed_at? / dismissed_at? / archived_at?
  archived_reason?: maintenance | user | proposal_retracted
```

`archived_reason = proposal_retracted` 是 YUK-19 引入的：当用户从待审区
撤回一个 `learning_intent` proposal 时，已物化的 hub + atomic LearningItems
+ 配套 artifact stub 会被同事务 tombstone。L3 correction event 链 +
`retractAiProposal()`（`src/server/proposals/actions.ts`）实现。

---

## 模块特定的待决策

### 已定

- 自我宣告 + 证据不足 → 软反问 + 强制覆盖（留痕）
- LearningItem 优先级 → Hybrid (user_pin + AI score)
- AI 主动提议触发: mastery>0.8/14d ∨ check 全过 ∨ 7d 错 0
- LearningItem 层级化 → 学习意图触发 1 hub + N atomic 自动拆分
- 状态扩展到 6 个（pending/in_progress/done/dismissed/resting/archived）
- hub status 自动聚合 children
- "复学"机制 → mastery 衰减 <0.5 持续 N 天 dreaming propose
- 优先级 score 4 维加权公式（urgency 0.4 / weakness 0.3 / recency 0.3 / pin 顶部）
- AI 主动提议完成走 DreamingProposal（kind=learning_item_completion）
- dismissed ≠ archived ≠ done：语义清晰区分

### 待 push

- 优先级权重的具体调参（Phase 2 跑数据后）
- 复学触发的 mastery 阈值具体值（默认 0.5，runtime 调）
- "按主题分组"切换的 UX 细节
- AI 主动提议完成被用户 dismiss 后的冷却期（默认 7 天）是否需要差异化（按知识点重要度调）
