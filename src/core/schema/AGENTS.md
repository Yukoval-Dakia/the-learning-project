# core/schema — Zod 业务 schema

> 跨学科 Zod schema 层（无 IO）。`generated.ts` = drizzle-zod 从 [`src/db/schema.ts`](../../db/schema.ts) 生成的基底；本目录用 `.extend()` 收窄 enum / jsonb 形状。Barrel = [`index.ts`](./index.ts)。领域词条见 [CONTEXT.md](../../../CONTEXT.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `index.ts` | barrel：Knowledge / Question / LearningItem / LearningRecord / Artifact / Answer / CompletionEvidence / 观测表 |
| `generated.ts` | drizzle-zod 生成的 `*InsertGenerated` / `*SelectGenerated` 基底（勿手改）|
| `business.ts` | 领域 enum + 子对象（QuestionKind / Rubric / ArtifactType / AgentRef...）|
| `event/` | **event discriminated union**（事件驱动核）——`actor_kind × action × subject_kind`，payload 按 Zod 守 |
| `structured_question.ts` | StructuredQuestion（OCR/rescue/manual/agent 共享唯一真相）|
| `learning_session.ts` | session envelope（type: ingestion/review/conversation/tutor/explore/create）|
| `cause.ts` | 归因 10 类 |
| `proposal.ts` | propose event payload |
| `note-patch.ts` | Living Note NotePatch ops |
| `capability.ts` / `profile-decl.ts` | capability registry + SubjectProfile 声明 |
| `activity.ts` · `coach.ts` · `tagging.ts` | 活动 / coach / 标注 schema |

## 关键约束
- 核心 action（`attempt/judge/propose/generate/review/rate/extract`）用 discriminated union **严守** payload；新交互用 `experimental:*` 命名空间先跑，稳了再 promote（ADR-0006 v2）。
- 旧表 schema 已删：`mistake` / `review_event` / `dreaming_proposal` / `ingestion_session` / `Judgment` / `UserAppeal` —— 全改为 event；FSRS 投影到 `material_fsrs_state`。

## ANTI-PATTERNS
- 别手改 `generated.ts`——改 `src/db/schema.ts` 后 `pnpm db:generate`。
- 别新建无 write path 的字段（`pnpm audit:schema` 会拦）。
