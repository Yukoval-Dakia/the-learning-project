# Strategy D · S1 — ingest→practice 桥接 implementation plan

**日期**：2026-06-05　**对象 main HEAD**：`63bc5867`（U 序列收官后，现场对 fresh main 勘察）
**主体**：YUK-214（ingest→practice/FSRS 桥接）
**搭车**：YUK-215（judge 手写照片穿透）
**doc riders**：合成 seed 分工说明 + TUNNEL_TOKEN 部署文档补全
**形态**：纯后端，可完全自主推进（无 UI，无 design pre-flight）

> 勘察核验：本 plan 引用的所有 file:line 已对当前 main 复核。briefing 的核心断言成立，**唯两处 YUK-215 实际比 briefing 描述的更小**（见 §6）。

---

## 1. 背景与目标

### 1.1 当前断点（briefing §1.3 (b)）

真实数据飞轮 = **ingest → 做题 → FSRS 信号 → Coach/brief 吃真实证据**。今天：

- ingest 通道已活（OCR→VLM→review→import 写 `question`+`event`+`learning_record`）；
- 知识级 FSRS 已通（import 写的 `knowledge_ids` 天然命中 due-list 知识级切片）；
- **但 ingest 出来的整卷无法在 `/practice` 直接做**——这是闭环里唯一的结构性断点。

**断点的精确机制**（已对 main 复核）：

1. `/practice` 消费端只认 `tool_quiz` artifact 且 `intent_source ∈ {review_plan, quiz_gen, embedded_check}`：
   - `app/api/practice/route.ts:46` `PAPER_INTENT_SOURCES = ['review_plan','quiz_gen','embedded_check']`，`:61` 拒非 `tool_quiz`，`:76` 拒不在白名单的 intent_source。
   - `src/server/review/practice-read.ts:144` `inArray(artifact.intent_source, ['review_plan','quiz_gen','embedded_check'])`——列表查询同样只捞这三种。
2. `app/api/ingestion/[id]/import/route.ts` 只调 `enrollCapturedBlock`（:432）写 `question`+`event`，**全程不写任何 artifact**（grep 确认 import route 无 `artifact` INSERT）。

→ 一张真实 ingest 的试卷，question 行都在，但没有 `tool_quiz` 容器把它们打成"一张可做的卷"，`/practice` 列表看不到、`/practice/[id]` 入不了。

### 1.2 目标

import 成功后，把本次 session 导入的 question 打包成一个 `tool_quiz` artifact（每题 = 一个 section assignment），写 artifact 行。打包后：

- 该卷出现在 `GET /api/practice` 列表（往日，新 source tab）；
- 用户能 `POST /api/practice` 起 review session、逐 slot 做（`/practice/[id]/answer` autosave + `/practice/[id]/submit` 提交）；
- 每 slot 走**已有的** paper judge（独立 judge event + `attribution_pending` 语义，paper-submit.ts）；
- FSRS 走**已有的**知识级调度（ADR-0028，paper-submit.ts:211 primary_knowledge → knowledge-keyed FSRS）。

**消费端零改动**——`readPaperSections`/`resolveSlotAssignment`/`getPracticeList`/`submitPaperSlot` 已全部支持 `tool_state.sections[]` 形状（U5 已 ship）。本 slice 只新增一条**写路径** + 一处**枚举/白名单扩容**。

---

## 2. 关键决策

### 2.1 桥接形态裁决（plan 核心）—— **OWNER-FORK**

三个候选：

| 形态 | 描述 | 评估 |
|---|---|---|
| **(a) import commit 时自动打包** | import 事务里/紧随其后，把本次 question_ids 自动写成一张 `tool_quiz` paper | 整卷自动进 `/practice` 待做列表 |
| **(b) 显式 API 动作** | 新增 `POST /api/ingestion/[id]/make-paper`，import 后用户/agent 显式触发组卷 | 卷只在显式请求后才出现 |
| **(c) 复用既有 tool** | 让 `write_review_plan` 之类既有 tool 把 ingested question 纳入 | 走 Coach 排期，不是"整卷做" |

**裁决：推荐 (b) 显式 API 动作 `POST /api/ingestion/[id]/make-paper`。标记为 OWNER-FORK，因为它影响 owner 日常在 `/practice` 看到什么。**

**理由（对反过度工程 + owner 真实使用流负责）：**

1. **ingestion 的典型输入是"已做过的错题卷"**（capture 错题——失败题 `outcome='failure'` 已写 attempt+mistake，正确题 `outcome='success'` 写 worked_example，未答题 `outcome='unanswered'` 进 item bank）。一张刚 ingest 完的错题卷，里面**大部分题用户刚刚做错并已被记录为 mistake**。若 (a) 自动把整张卷塞进 `/practice` 待做列表，等于让用户"把刚做错的卷子立刻原样再做一遍"——这不是 owner 想要的默认行为，且与"知识级 FSRS 会在正确时机重新调度这些 failed 知识点"的设计**冗余甚至冲突**（failed 题已进 never-reviewed-failure 切片，会被 due-list 自然召回；再叠一张全卷待做是噪音）。

2. **真正有价值的"整卷做"场景是 `unanswered` item-bank 卷**：owner ingest 一张"想做但还没做"的练习卷（每题 `outcome='unanswered'`，不写 attempt event，**不自动进调度池**——这是 briefing §1.3 (a) 指出的设计缺口）。这种卷**正需要**一个显式"做这张卷"的入口。显式 API 让 owner（或上层 UI/agent）按场景决定"这张卷要不要做"，而不是无差别全塞。

3. **(b) 不破坏 owner 的 `/practice` 列表语义**：`/practice` 今天是"Coach 排期 + 自定义组卷 + note 嵌入检查"三类**主动学习产物**。无差别自动灌入每张 ingest 卷会把列表变成 ingest 历史的镜像，稀释信号。显式触发让"出现在 /practice = 我决定要做这张卷"这条语义保持干净。

4. **(b) 与既有原语最对齐、增量最小**：复用 `write_review_plan` 已验证的 artifact 形状 + 现有 import 状态机。显式 route 是薄壳：读 session 的 imported question_ids → build `tool_state` → INSERT artifact，没有新事务复杂度耦合进 import 主链路（import 已是一个带 FOR UPDATE 锁的大事务，往里塞 artifact 写会扩大锁范围与回滚面）。

**(a) 的唯一优势**是"零额外点击"，但代价是产品语义被污染 + 与 FSRS 调度冗余，违背反过度工程（为不一定要做的卷建待做项）。**故推荐 (b)，但这是产品级分叉，须 owner 拍板。** 若 owner 更想要"ingest 完即可做"的零摩擦体验，可改 (a)——实现上只是把 §5 的 route handler 逻辑内联到 import route 的事务后段，数据形状完全一致，切换成本低。

> **OWNER-FORK 待拍板项**：
> - **F-A**：桥接形态 (a) 自动 vs **(b) 显式**（推荐 b）。
> - **F-B**：若选 (b)，是否限定只对 `unanswered`-majority 的卷开放组卷？（推荐：不限定，任何 imported session 都可组卷，但默认不自动触发——把"做不做"留给 owner。）
> - **F-C**：组卷的 question 选取范围——本次 import 的**全部** question vs 仅 `unanswered` 的 item-bank 题？（推荐：全部本次 imported question，因为"整卷复现"对 failed 题也有"完整重做一遍"的合法用例。**本 slice 不实现 `outcome_filter`**——outcome 在 event 不在 question 行，按 outcome 过滤要 join event 流，超出薄壳 route 范畴；见 Cross-统合 F-9。若 owner 要"只组未答题"，单开 follow-up。）

### 2.2 不新增表（复用 artifact 既有表）

桥接的容器就是 `tool_quiz` artifact，**复用 `artifact` 表**（schema.ts:324），`tool_state` jsonb 存 `{question_ids, sections[], session_meta}`（与 `write_review_plan` 输出同形）。**无新表、无新列、无 migration**——满足反过度工程与 `audit:schema`（artifact 既有列都有 write path）。

### 2.3 新增一个 paper intent_source 值 `ingestion_paper`（唯一枚举改动）

`/practice` 的 paper 识别硬编码三值白名单（§1.1）。要让 ingestion 卷被识别，**必须新增第四个 paper 源**。决策：新增 `intent_source = 'ingestion_paper'`、`tool_kind = 'ingestion_paper'`，并在所有 paper 白名单处加入。理由：

- 用现有三值之一（如 `quiz_gen`）会**污染 provenance**——practice-read 的 source-tab 映射（`intentSourceToPracticeSource`）会把 ingest 卷错标成"自定义组卷"，且与"AI 生成"的语义不符（ingest 卷是用户真实试卷，非 AI 生成）。
- 新增一个语义干净的值是 pure-additive 枚举扩容（与 U5 加入三值的做法一致，index.ts:130-132 注释先例），不需要 migration（`intent_source`/`tool_kind` 是 text 列），只改 Zod 枚举 + 三处白名单 + 一处 source 映射。

> 这是技术选型（枚举值），不是产品分叉，按项目纪律不 surface，记录于此供 review。

### 2.4 尊重"不做清单"

- 不翻 `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`（本 slice 与 auto-enroll flag 无关）。
- 不给 `question_block` 加 `ai_suggested_*` 列（ADR-0026 event-marker-only；本 slice 不碰 question_block schema）。
- 不碰 `/record` redraw、不做 OC-5 UI、不修 `solution-generate` figures_hint。

---

## 3. 数据流与 artifact 形状（具体到字段）

### 3.1 桥接数据流

```
import route (现有) → 写 N×question + N×event + N×learning_record，返回 question_ids[]
        │
        ▼ (owner/UI/agent 显式触发，形态 b)
POST /api/ingestion/[id]/make-paper
        │  1. 校验 session 存在且 status='imported'（终态）
        │  2. 反查本次 session 导入的 question 行（见 §3.3 反查口径）
        │  3. build tool_state.sections[]（每题 = 1 assignment，§3.2）
        │  4. INSERT artifact(type='tool_quiz', intent_source='ingestion_paper', generation_status='ready')
        ▼
GET /api/practice → 列表出现该卷（往日，source='ingestion'）
POST /api/practice {artifact_id} → 起 review session（practice/route.ts 白名单需含 ingestion_paper）
POST /api/practice/[id]/answer / submit → 逐 slot 做题，走现有 paper judge + 知识级 FSRS
```

### 3.2 artifact 行字段（对照 `write_review_plan` review-plan-tools.ts:783-806 与 `quiz_gen` quiz_gen.ts:399-431）

```ts
{
  id: `ingestion_paper_${createId()}`,
  type: 'tool_quiz',                       // practice gate 必需 (practice/route.ts:61)
  title: `${sourceDocTitle ?? '导入试卷'}`, // 来自 source_document.title 或 fallback
  parent_artifact_id: null,
  knowledge_ids: [...unique 所有题的 knowledge_ids],  // 列表 chip + by-knowledge 入口
  intent_source: 'ingestion_paper',        // 新值 (§2.3) — practice 白名单识别
  source: 'imported',                      // 非 'ai_generated'（用户真实卷）
  source_ref: sessionId,                   // 回指 ingestion session（可追溯）
  body_blocks: null,
  attrs: { ingestion_session_id, source_document_id, entrypoint } as never,
  tool_kind: 'ingestion_paper',            // 新值 (§2.3)
  tool_state: {                            // ToolStateT v2 (business.ts:335-341)
    question_ids: [...每题 id，assignment 顺序],
    sections: [                            // ToolStateSectionT (business.ts:322-333)
      {
        knowledge_focus: [...该卷全部 knowledge_ids],
        feedback_policy: 'immediate',      // 非 'judge_now_show_later' → 即时可见
        adaptation_policy: 'none',
        assignments: [                     // 每题一条 (ToolStateAssignment business.ts:307-319)
          {
            question_id,
            // part_ref 省略（atomic；ingested question 无 StructuredQuestion 子节点 slot）
            primary_knowledge_id: question.knowledge_ids[0],  // 驱动知识级 FSRS
            secondary_knowledge_ids: question.knowledge_ids.slice(1),
            selection_reason: 'ingested_paper',
            review_profile_snapshot: {},
          },
          ...
        ],
      },
    ],
    session_meta: {                         // 透明审计 + tool_context 追溯
      ingestion_session_id: sessionId,
      source_document_id,
      tool_context_task_run_id: null,       // 非 agent 产物
    },
  } as never,
  generation_status: 'ready',               // practice gate 必需 (practice/route.ts:68)
  verification_status: 'not_required',
  history: [],
  created_at, updated_at, version: 0,
}
```

**关键不变量（对照消费端）：**
- `resolveSlotAssignment`（paper-sections.ts:117）按 `(question_id, part_ref)` 匹配 assignment → 取 `primary_knowledge_id` 驱动 FSRS、`feedback_policy` 驱动可见性。本形状每个 assignment 都有 `primary_knowledge_id`（题至少有 1 个 knowledge_id，否则 import 不会通过——import route:222-232 强制 `knowledge_ids.min(1)`）。
- `getPracticeList` total_slots = `readPaperSections` 解出的 distinct slot 数（practice-read.ts:295-302）。每题一 slot，无重复。
- `feedback_policy='immediate'` → 即时可见判分（paper-submit.ts:216 仅 `'judge_now_show_later'` 才 buffer）。

### 3.3 反查"本次 session 导入的 question"口径

import route 写 question 时在 `question.metadata` 里塞了 `ingestion_session_id`（import/route.ts:406）。**反查口径**：`question.metadata->>'ingestion_session_id' = sessionId`。

> 备选：也可在 make-paper 时接受 route body 传入 `question_ids[]`（由 import 返回值前端透传），避免反查。但反查更 robust（不依赖前端状态、显式 API 可独立重放）。**推荐反查 metadata**；route 同时接受可选 `question_ids` body 作为显式 override（为空则反查）。

### 3.4 分页/排序

artifact 一次性打包全部本次 question（一张卷通常 < 50 题），单 section。若未来需要分 section（按知识点/难度），形状已支持多 section，本 slice 不做（YAGNI）。

---

## 4. 单元/集成边界总览

| 改动 | 文件 | 分区 |
|---|---|---|
| 新 route handler 逻辑 | `src/server/ingestion/make-paper.ts`（新建，可纯函数测） | unit（纯 build）+ db（整链路） |
| route 壳 | `app/api/ingestion/[id]/make-paper/route.ts`（新建） | db |
| Artifact 枚举 +2 值 | `src/core/schema/index.ts` | unit |
| practice 白名单 +1 | `app/api/practice/route.ts`、`src/server/review/practice-read.ts` | db（route）/ unit（read 纯函数部分若可拆） |
| source 映射 +1 | `src/server/review/practice-read.ts` `intentSourceToPracticeSource` | unit |
| YUK-215 paper judge 透传 | `src/server/review/paper-submit.ts` | db |
| YUK-215 single-question judge 透传 | `app/api/review/submit/route.ts` | db |

---

## 5. 实施步骤（YUK-214 主体）

### Step 1 — Artifact 枚举 + practice 白名单扩容（pure additive）

**文件：**
- `src/core/schema/index.ts`（修改）：`intent_source` enum 加 `'ingestion_paper'`（:133-141）；`tool_kind` enum 加 `'ingestion_paper'`（:146）。
- `app/api/practice/route.ts`（修改）：`PAPER_INTENT_SOURCES` 加 `'ingestion_paper'`（:46）。
- `src/server/review/practice-read.ts`（修改）：`inArray(...)` paper 白名单加 `'ingestion_paper'`（:144）；`intentSourceToPracticeSource` switch 加 `case 'ingestion_paper': return 'other'`（映射裁决见下）；**并给该函数加 `export`**（当前 :79 是私有 `function intentSourceToPracticeSource`，加 export 以便 unit 直测，见 §8 / Cross-统合 F-11）。

**裁决（PracticeSource 映射）— 先 `'other'`，不新增 `'ingested'`**：`PracticeSource` 类型（practice-read.ts:77）当前 = `'coach'|'custom'|'note'|'other'`。ingestion 卷**映射到既有 `'other'` 兜底**，不在本 slice 新增 `'ingested'` 成员。

- **为什么不新增 `'ingested'`**：卷能否进 `/practice` 主列表，**只取决于 :144 白名单是否含 `ingestion_paper`**（`getPracticeList` map 的 `paperRows` 已被 :144 `inArray` 过滤），与 `source` 映射值无关——`source` 字段（:309）仅决定客户端 source-tab 归类。映射到 `'other'`，卷照常出现在 `今日/往日` 主列表，**无半可见死角**（已对 practice-read.ts:285-309 复核：source 兜底不影响列表收录）。新增 `'ingested'` 是 UI-facing 字符串扩容，但本 slice 不上配套 tab UI，独立 tab 价值悬空 → YAGNI，留 UI wave。
- 代码注释标注"待 OC/UI wave 决定是否独立 `'ingested'` tab"（phase-deferred 注释纪律）。

**测试：**
- `src/core/schema/artifact-u5.test.ts`（或同目录新 case，**unit**）：`Artifact.parse` 接受 `intent_source:'ingestion_paper'` + `tool_kind:'ingestion_paper'` 不抛。
- `intentSourceToPracticeSource('ingestion_paper') === 'other'`（**unit**，import now-exported 函数，见 §8）。

### Step 2 — make-paper 组卷纯函数

**文件：** `src/server/ingestion/make-paper.ts`（新建）。导出 `buildIngestionPaperToolState(questions): ToolStateT`（纯函数，输入 question 行数组 → 输出 §3.2 的 tool_state）+ `createIngestionPaper(db, {sessionId, questionIds?})`（DB 写：反查 question → build → INSERT artifact → 返回 artifact_id）。

**关键实现点：**
- 反查 `question.metadata->>'ingestion_session_id' = sessionId`（§3.3，已对 import/route.ts:406 复核——question 行 metadata 确实写入 `ingestion_session_id`），或用传入的 `questionIds`。
- 经 `ToolState.parse(...)`（business.ts:335）写入前过 Zod barrier（RL4 纪律，与 write_review_plan:769 一致）。
- 校验：至少 1 题，否则 throw（拒空卷，对照 write_review_plan:648）。
- **幂等（纯 sessionId 维度）**：advisory-lock keyed on sessionId + 查已有 `intent_source='ingestion_paper' AND source_ref=sessionId` 的 artifact，存在则返回既有 id（对照 write_review_plan:742-762 per-run 锁先例），避免重复点击造重复卷。**幂等键仅含 sessionId**——因为本 slice route body 不带 `outcome_filter`（见 Step 3 / Cross-统合 F-9），组卷范围固定为"本次 imported 全部 question"，不存在"同 session 不同 filter"的多卷分叉，幂等无歧义。

**测试（双文件，预拆——见 Cross-统合 F-12）：**
- `src/server/ingestion/make-paper.unit.test.ts`（**unit**，零 DB import）：`buildIngestionPaperToolState` 纯函数——给定 question 行数组，断言 sections/assignments/question_ids 形状正确、primary_knowledge_id = knowledge_ids[0]、feedback_policy='immediate'。
- `src/server/ingestion/make-paper.db.test.ts`（**db**，import `tests/helpers/db`）：`createIngestionPaper` 整路——seed session+imported questions → 调用 → 断言 artifact 行字段 + 幂等重复返回同 id。
- **不混在同一 `make-paper.test.ts`**：`audit:partition` 是 file-level lint（scripts/audit-test-partition.ts 扫每个 `*.test.ts` 的 file-level import；在 `fastTestInclude` 又直接 import DB = P0 ERROR → `pnpm test:unit` runtime crash）。凡 import `tests/helpers/db` 的整文件归 db config，故组卷纯函数与 DB 链路必须分文件，不留"实施时再确认"。

### Step 3 — route 壳

**文件：** `app/api/ingestion/[id]/make-paper/route.ts`（新建）。`POST`，body `{ question_ids?: string[] }`（**仅此一字段，可选**），校验 session `status='imported'`，调 `createIngestionPaper`，返回 `{ artifact_id }`。`export const runtime = 'nodejs'`。仅导出识别的 handler（YUK-67 next build 约束）。

> **Cross-统合 F-9：本 slice 砍掉 `outcome_filter`。** 原 plan 提议 route 接受可选 `outcome_filter`（只组未答题）。砍掉理由：(1) **outcome 不在 question 行上**——已对 schema.ts 复核，`question` 表无 outcome 列；outcome 是 attempt **event** 的属性（schema.ts:601 `event.outcome` + :626 `event_action_outcome_idx`）。按 outcome 过滤要 join event 流，远超"反查 question.metadata 一句 SQL"，§3.3 的反查口径根本不覆盖 outcome。(2) F-C 本身推荐"全部 imported question"。综合，`outcome_filter` 是未落地半成品参数，徒增 route surface + 幂等复杂度（F-7）却无 acceptance → 砍掉符合反过度工程纪律。若 owner 日后要按 outcome 细分，单开 follow-up（§11 已留口）。

**测试：**
- `app/api/ingestion/[id]/make-paper/route.test.ts`（**db**，testDb + memR2 + mock AI runner，对照 import/route.test.ts:24-31）：
  - happy path：imported session → 200 + artifact_id；
  - session not imported（status='extracted'）→ 409；
  - session 不存在 → 404；
  - 端到端贯通断言：make-paper 后 `getPracticeList` 含该卷、`POST /api/practice {artifact_id}` 起 session 成功（**这是闭环验收的核心断言**）。

### Step 4 — 闭环贯通集成测试

**文件：** `app/api/ingestion/[id]/make-paper/route.test.ts` 内或单独 `src/server/ingestion/ingest-practice-bridge.test.ts`（**db**）：
- import 一张 session（含 failure + unanswered 题）→ make-paper → `POST /api/practice` 起 session → `POST /api/practice/[id]/submit` 提交一 slot（用 deterministic `exact` judge，对照 paper-cycle.test.ts:17-18 模式，无需 LLM mock）→ 断言：attempt event + 独立 judge event 写出、FSRS 知识级 projection 更新、`getPracticeList` 的 pos/right/wrong 正确。

---

## 6. YUK-215 搭车步骤（judge 手写照片穿透）

> **勘察修正**：briefing 称两处都缺。实测——judge invoker **已支持** `student_image_refs`（`src/server/judge/invoker.ts:46` input schema + :154/:165 透传给 steps/multimodal judge）。所以两处都只是"调用点没把已有的 image refs 传进去"，无需改 invoker、无需改 schema 能力层。比 briefing 描述更小。
>
> **Cross-统合 F-2 路径校正**：invoker 真实路径是 **`src/server/judge/invoker.ts`**（已对 review/submit/route.ts:39 `import { createDefaultJudgeInvoker } from '@/server/judge/invoker'` 复核，`find src -path '*judge*invoker*'` 仅命中此一文件），**不是** `src/server/review/judge/invoker.ts`。行号 :46/:154/:165 正确，目录是 `server/judge/` 非 `server/review/judge/`。本节及测试节所有 `invoker` 引用按此为准（`vi.spyOn` target = `@/server/judge/invoker` 模块）。

### Step 5 — paper judge 透传（1 行）

**文件：** `src/server/review/paper-submit.ts`（修改）。`submitPaperSlot` 已把 `input.answerImageRefs` 存进 attempt event payload（:425），但 `invoke()` 调用（:194-199）没传。改为：

```ts
const invoked = await createDefaultJudgeInvoker().invoke({
  db, question: q, answer_md: input.answerMd,
  student_image_refs: input.answerImageRefs,   // ← 新增（input 已有此字段，:53）
  subjectProfile,
});
```

route 层（practice/[id]/submit/route.ts:69）已把 `body.image_refs` → `answerImageRefs`，无需改 route。

### Step 6 — single-question judge 透传（SubmitBody +1 字段 + invoke +1 参数）

**文件：** `app/api/review/submit/route.ts`（修改）。

> **Cross-统合 F-16 命名定死（不留实施期悬念）**：已对既有约定复核——**event payload 字段统一叫 `answer_image_refs`**（review plan/due/weekly 测试 payload 全用 `answer_image_refs`；paper attempt payload 也是 `answer_image_refs`，paper-submit.ts:425），**route body 入参在 paper 侧叫 `image_refs`**（practice/[id]/submit/route.ts:27）。两层命名是既有分层事实，非冲突。本 Step 据此定死：

- `SubmitBody`（:54-79）加 `answer_image_refs: z.array(z.string()).default([])`（与既有 event-payload 约定对齐；single-question review 走自己的 route，body 字段名独立，采 payload 同名以减一次映射）。
- `invoke()` 调用（:127-132）加 `student_image_refs: body.answer_image_refs`（invoker 直收，无 Zod barrier，见 §6 开头修正）。
- **必做（非可选）**：把 image refs 写进 review event payload（:364 区）的 `answer_image_refs`，与 paper attempt payload :425 对齐。**升为必做的理由**：手写照片进了 judge 却不留在 event 流 = 软判分依据不可追溯，违反项目 evidence 留痕纪律（AI/系统动作必须可追溯可回滚）。

**YUK-215 测试：**
- paper 路径（**db**，扩 paper-cycle.test.ts 或新 case）：submit 一 slot 带 `image_refs` → 断言 invoke 收到 `student_image_refs`（用 `vi.spyOn(invokerModule,...)` 断言入参，对照 paper-cycle.test.ts:20 已 import invokerModule）。
- single-question 路径（**db**，扩 review/submit/route.test.ts）：submit 带 `answer_image_refs` → 断言 invoke 收到 + event payload 含该字段。

> YUK-215 是否真要做取决于 OWNER-FORK F-D：**owner 的真实做题习惯是否会拍手写答案照片？** 若 owner 一律打字作答，此搭车可缓。briefing §2 已点名 215 为本 slice 一部分，默认做；若 owner 否，则只留 plan、不实现。

---

## 7. doc riders 步骤

### Step 7 — 合成 seed 分工说明（briefing Fork 3，倾向 A）

**文件：** `docs/design/2026-05-15-data-assumptions.md`（修改，追加一节）或 `scripts/seed-synthetic.ts` 头注。明确写入：

> **合成 seed 定位（2026-06-05 Strategy D）**：`scripts/seed-synthetic.ts` 与 `layer8_e2e.db.test.ts` 的合成数据**仅作测试 harness / 确定性 regression guard**。真实 ingest 数据替代的是**生产运行时信号源**（FSRS / Dreaming / Coach brief 吃的真实证据），二者分层：测试用确定性合成数据更稳，真实 fixture 做 regression 会引入数据漂移。合成 seed **不退役**；真实数据进来后也不迁测试到真实 fixture。

写进 data-assumptions doc（它已是数据假设的单一出处）。

### Step 8 — TUNNEL_TOKEN 文档补全（briefing Fork 4，owner 选 NAS .env）

> **勘察修正**：`.env.example` **已含** `TUNNEL_TOKEN=`（:94-96，Cloudflare Tunnel 段）。briefing §1.1 称"在 .env 中根本不存在"——指真实 NAS `.env`（运行时），非 `.env.example` 模板。所以**无需改 `.env.example`**。

**文件：** `docs/deploy/real-ingestion-provisioning.md`（修改 §3，:51-65）。在 §3 "Where to set them" 的 NAS/prod 项补一行 cloudflared 依赖说明：

> NAS / prod 启动 compose 前，`TUNNEL_TOKEN` 必须写进注入 app+worker 的 compose `.env`（cloudflared ingress 依赖；缺它 tunnel 容器起不来）。owner 选定写在 NAS `.env`（与其他凭证同处）。Zero Trust dashboard → Networks → Tunnels 生成。

可选：把 `TUNNEL_TOKEN` 加进 `pnpm preflight:ingestion` 的 presence 检查（当前 grep 未命中 scripts 含 TUNNEL_TOKEN）——但 cloudflared 不阻断 ingestion 主链路（只是外网 ingress），**不建议**加进 ingestion preflight（属部署 preflight 范畴，非 ingestion 数据链路），仅文档说明即可。

---

## 8. 测试矩阵（unit / db 分区落位）

| 测试 | 文件 | 分区 | 依据 |
|---|---|---|---|
| Artifact 接受新 intent_source/tool_kind | `src/core/schema/artifact-u5.test.ts` | **unit** | 纯 Zod，无 DB |
| `buildIngestionPaperToolState` 形状 | `src/server/ingestion/make-paper.unit.test.ts` | **unit** | 纯函数，零 DB import |
| `intentSourceToPracticeSource('ingestion_paper')==='other'` | `src/server/review/practice-read.unit.test.ts`（或同 unit 文件） | **unit** | 纯映射函数（需 export，Step 1） |
| `createIngestionPaper` 整链路 + 幂等 | `src/server/ingestion/make-paper.db.test.ts` | **db** | import `tests/helpers/db` |
| make-paper route happy/409/404 | `app/api/ingestion/[id]/make-paper/route.test.ts` | **db** | testDb + memR2 + mock runner |
| 闭环贯通（import→paper→practice→submit→FSRS） | 同上或 `ingest-practice-bridge.test.ts` | **db** | deterministic exact judge |
| YUK-215 paper judge 收到 image refs | 扩 `paper-cycle.test.ts` | **db** | spyOn `@/server/judge/invoker`（F-2） |
| YUK-215 single-question judge + payload | 扩 `app/api/review/submit/route.test.ts` | **db** | testDb；断言 invoke 收到 + event payload 含 `answer_image_refs` |

**分区纪律**：凡 import `tests/helpers/db`/`@/db/client`/`postgres`/`drizzle`/`PgBoss` 的进 **db** config；纯函数（build tool_state、Zod parse、source 映射）进 **unit**。**make-paper 测试预拆为双文件**：`make-paper.unit.test.ts`（纯 `buildIngestionPaperToolState`，零 DB import）+ `make-paper.db.test.ts`（`createIngestionPaper` 整链路 + 幂等）。**不留"实施时确认拆法"的悬念**——`audit:partition` 是 file-level lint（已对 scripts/audit-test-partition.ts 复核），import DB 的文件混进 fastTestInclude = P0 ERROR，定论拆。`intentSourceToPracticeSource` 测试要求该函数 `export`（Step 1，已对 :79 私有复核），加 export 后进 unit。

**PR 前 gate**：`pnpm typecheck`、`pnpm lint`、`pnpm audit:schema`（确认无新列，artifact 既有列已有 write path——本 slice 新 write path 写既有列，audit:schema 应 PASS）、`pnpm audit:partition`、`pnpm audit:profile`、`pnpm test`、`pnpm build`。

---

## 9. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 新 intent_source 漏改某处 paper 白名单，卷出现/起 session 不一致 | grep `review_plan.*quiz_gen.*embedded_check` 找全部三值并列处，逐一加第四值（已知 2 处：practice/route.ts:46、practice-read.ts:144；Artifact enum index.ts:133；source map:79） | 移除枚举值 + 白名单项即可；artifact 行可保留（不被识别即不显示，无副作用） |
| import metadata 反查口径不稳（混合 schema 行） | route 同时接受显式 `question_ids` body override（§3.3）；反查仅作 fallback | 用显式 question_ids 路径 |
| 自动 vs 显式（形态 a/b）选错产品方向 | OWNER-FORK 先拍板；(b)→(a) 切换成本低（逻辑内联到 import 事务后段） | 删 make-paper route，import 不变 |
| 幂等缺失造重复卷 | sessionId advisory-lock + source_ref 查重（§Step 2） | 软删重复 artifact（artifact 支持 soft-delete，schema.ts:382） |
| 重复做"刚做错的卷"与 FSRS 调度冗余 | 形态 (b) 让 owner 决定做不做（本 slice 不实现 outcome filter，见 F-9） | — |
| YUK-215 命名 `image_refs`（route body）vs `answer_image_refs`（event payload） | 已定死为既有分层约定（Cross-统合 F-16），非冲突；review body 采 `answer_image_refs` | 字段 default `[]`，旧 caller 不受影响 |

**整体回滚性**：本 slice **纯增**（新 route + 新 server module + 枚举扩容 + 2 处 judge 透传），无 schema 变更、无既有行为改写（paper-submit 单题/single-question judge 在无 image_refs 时行为字节级不变，因 `student_image_refs` optional）。回滚 = revert PR，无数据迁移。

---

## 10. Out of scope（本 slice 明确不做）

1. **不做 OC-5 复查面 UI / `/record` redraw / `auto_enrolled` mode tab**（briefing 不做清单 #6，候选 A 范畴）。
2. **不翻 `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`**（不做清单 #1）。
3. **不给 question_block 加 ai_suggested_* 列**（不做清单 #2，ADR-0026 event-marker-only）。
4. **不修 `solution-generate.ts` figures_hint**（不做清单 #5）。
5. **不做多 section / 按难度分卷 / 自适应组卷**（YAGNI，形状已支持，需求未现）。
6. **不做 `/practice` 新 source tab UI**（read 层先映射 `'other'`；独立 tab 留 UI wave）。
7. **不改 judge invoker 能力层 / 不加新 judge route**（YUK-215 复用既有 `student_image_refs`）。
8. **不退役合成 seed**（doc rider 明确分层保留）。
9. **不把 TUNNEL_TOKEN 加进 ingestion preflight**（部署范畴，仅文档说明）。

---

## 11. Linear capture

- **YUK-214**：本 plan 主体。briefing §6 指出"ingest→practice tool_quiz artifact 桥接当前无 Linear 编号"——若 owner 采纳本 plan，应建/确认 YUK-214 issue（本 plan 已以 YUK-214 命名，假定已开或将开）。
- **YUK-215**：judge 手写照片穿透，搭车。已有编号。
- **后续可能 follow-up**（实施中若浮现）：(1) `/practice` 独立"导入试卷" source tab（UI wave）；(2) make-paper 的 outcome-filter 组卷（F-C 若 owner 要细分，已从本 slice 砍出，见 F-9）。实施完成时按 issue capture gate 决定是否落单。

---

## 12. Cross-统合修订记录（2026-06-05）

Cross-统合 agent（有否决权）对 fresh main `63bc5867` 复核 18 处 file:line，逐条裁决 plan-critic 的 5 REVISE + NIT，并补全局一致性检查。**判定：SHIP（条件 = 4 项 OWNER-FORK 待拍板，纯产品/部署偏好，不阻塞方向）。** 桥接方向（形态 b 显式 route / tool_quiz artifact 复用 / 消费端零改动 / FSRS-attribution-visibility 落账 / audit:schema PASS / YUK-215 两处透传）全部站得住，0 BLOCKER。

### A. critic REVISE 裁决（5 条，全 ACCEPT，已落地）

| # | 裁决 | 落地位置 | 复核证据 |
|---|---|---|---|
| **F-2** invoker 路径写错 | **ACCEPT** | §6 开头加路径校正注 + §8 spyOn target 改 `@/server/judge/invoker` | `find src -path '*judge*invoker*'` 仅 `src/server/judge/invoker.ts`；review/submit/route.ts:39 import `@/server/judge/invoker`（无 `review/`） |
| **F-7** 幂等键与 filter 维度冲突 | **ACCEPT** | §Step 2 幂等定为纯 sessionId 维度，并显式说明"因砍 outcome_filter 无多卷分叉" | 与 F-9 联动消解 |
| **F-9** `outcome_filter` 是未落地半成品 | **ACCEPT** | §Step 3 加 F-9 注砍掉；§2.1 F-C / §9 风险表同步清理；route body 仅留 `{question_ids?}` | schema.ts:502/601/626 — `question` 表无 outcome 列，outcome 是 `event.outcome` 属性，按 outcome 过滤要 join event 流，§3.3 反查口径不覆盖 |
| **F-11** `intentSourceToPracticeSource` 私有不可单测 | **ACCEPT** | §Step 1 加 `export` 指令；§8 矩阵该行标"需 export" | practice-read.ts:79 `function intentSourceToPracticeSource`（无 export），仅 :309 内部用 |
| **F-16** single-question 命名 + event payload 写入升必做 | **ACCEPT（带证据收口）** | §Step 6 命名定死（route body `image_refs` / event payload `answer_image_refs` 既有分层）+ event payload 写入升"必做" | review plan/due/weekly 测试 payload 全用 `answer_image_refs`；paper attempt payload :425 同名；practice submit route body :27 用 `image_refs` |

**REJECT：0 条。** critic 全部 REVISE 经独立复核成立，无驳回。

### B. NIT 处理

critic 11 条 NIT（F-1/3/4/5/6/8/10/12/13/14/15）均"已核验为真"，其中 **F-12（audit:partition file-level → make-paper 测试必拆双文件）从"实施时确认"升为 plan 阶段定论**，已落 §Step 2 + §8。其余 NIT 为措辞确认，原 plan 表述已准确，不重复改写。

### C. 全局一致性检查（planner/critic 之外的跨切面，Cross-统合补）

1. **`getPracticeList` 列表收录 vs source 映射解耦（关键）**：已对 practice-read.ts:285-309 复核——`getPracticeList` map 的 `paperRows` 已被 :144 `inArray(intent_source,[白名单])` 过滤，**卷能否进 `/practice` 主列表只取决于 :144 加没加 `ingestion_paper`，与 `intentSourceToPracticeSource` 映射值无关**。故 §Step 1"先映射 `'other'`"无半可见死角（卷照常进主列表，`source` 只决定 tab 归类）。**强化了不新增 `'ingested'` 的 YAGNI 裁决**（见 §Step 1 改写）。
2. **index.ts enum 是真·required（隐藏断点确认）**：若 `intent_source='ingestion_paper'` 不加进 Artifact Zod enum（index.ts:133），`Artifact.safeParse(row)`（practice-read.ts:292）fail → `toolState=null` → total_slots 退化为 flat `question_ids.length`（仍工作但丢 section 语义）。enum 扩容是 Step 1 已含的必改项，确认无遗漏。
3. **primary_knowledge_id 非空不变量成立**：import/route.ts:63 `knowledge_ids: z.array(...).min(1)` 强制非空 → `knowledge_ids[0]` 必有值 → §3.2 assignment 的 `primary_knowledge_id` 驱动 ADR-0028 知识级 FSRS 不会空指针。
4. **ADR-0026 event-marker-only 不触碰**：本 slice 不碰 question_block、不加 `ai_suggested_*` 列，与 auto-enroll flag 正交。一致。
5. **ADR-0028 调度单元=知识点 + U5 paper 不变量尊重**：feedback_policy='immediate'（paper-submit.ts:40 `HIDE_FEEDBACK_POLICY='judge_now_show_later'`，:216 仅该值 buffer）→ 即时可见正确；独立 judge event + attribution_pending（:464）语义未被本 slice 触碰。一致。
6. **YUK-211（sendBeacon 401）/ YUK-212（part 收窄）交互**：本 slice 不触碰 practice autosave 的 sendBeacon 路径（YUK-211 范畴），也不动 part_ref 收窄逻辑（YUK-212）——§3.2 assignment `part_ref` 省略（ingested question atomic 无 StructuredQuestion 子节点），不引入新 part 维度。两已知缺口无新增交互面。
7. **audit:schema allowlist 不需动**：桥接新 write path 写 artifact **既有列**（source/source_ref/intent_source/tool_kind/tool_state 等都有现成 write path via write_review_plan/quiz_gen）；intent_source/tool_kind 是 text 列，加枚举值无 migration。无新字段 → 无需新 allowlist 条目。audit:schema 应 PASS。
8. **与 YUK-164 后续 OC-5 站（候选 A）不留死路**：本 slice 不碰 `/record` redraw、不映射 `'ingested'` tab，OC-5 wave 仍可独立按需新增 `PracticeSource='ingested'` + 配套 tab；ingestion_paper 的 source 兜底到 `'other'` 不与 OC-5 设计冲突。衔接开放。

### D. 待拍板 OWNER-FORK（4 项，纯产品/部署偏好，Cross-统合不擅自拍板）

- **F-A**：桥接形态 (a) import 自动打包 vs **(b) 显式 `POST /api/ingestion/[id]/make-paper`**。**推荐 (b)**（理由 §2.1：ingest 典型输入是已做过的错题卷，自动全塞 `/practice` 与知识级 FSRS 召回冗余；(b)→(a) 切换成本低）。
- **F-B**：若选 (b)，是否限定只对 `unanswered`-majority 卷开放组卷。**推荐不限定**（任何 imported session 可组，默认不自动触发）。
- **F-C**：组卷范围全部 imported question vs 仅 unanswered。**推荐全部**；**本 slice 不实现 outcome_filter**（F-9 已砍，按 outcome 过滤需 join event 流，超薄壳 route 范畴）。
- **F-D**：YUK-215 是否做，取决于 owner 真实做题是否拍手写答案照片。**推荐做**（增量极小，纯增，无 image_refs 时行为字节级不变）；若 owner 一律打字，可只留 plan 不实现。

### E. SHIP/HOLD 判定

**SHIP。** 0 BLOCKER；5 REVISE 全 ACCEPT 并落地；全局一致性 8 项检查通过；4 项 OWNER-FORK 是产品/部署偏好分叉，不阻塞实施方向（实施者可在 F-A 拍板后即开工，F-D 决定 YUK-215 做不做）。slice 形态 = 纯增（新 route + 新 server module + 枚举扩容 + 2 处 judge 透传 + 1 处 export），无 schema 变更、无既有行为改写，回滚 = revert PR。

## §13 OWNER 拍板记录（2026-06-05，开工授权）

四项 OWNER-FORK 已由 owner 全部拍板（AskUserQuestion 两轮）：

| Fork | 拍板 | 备注 |
|---|---|---|
| **F-A** 桥接形态 | **(b) 显式 `POST /api/ingestion/[id]/make-paper`** | 按推荐 |
| **F-B** 组卷准入 | **不限定**——任何 imported session 可组卷，默认不自动触发 | 按推荐 |
| **F-C** 组卷范围 | **全部 imported question**（整卷复现语义）；outcome_filter 维持砍掉（F-9） | 按推荐 |
| **F-D** YUK-215 搭车 | **做**——owner 确认日常做题会拍手写答案照片（kickoff 轮已拍板） | 按推荐 |

另两项 kickoff 轮拍板（doc riders 范围）：合成 seed 定位 = 仅测试 harness（分工写进文档）；TUNNEL_TOKEN 注入方式 = 写 NAS `.env`（runbook §3 + `.env.example` 同步补）。

**实施自此开工。**
