# ingestion — OCR / 抽取 pipeline

> 用户上传材料 → 抽取 → 落库的服务层。**结构化抽取 = 确定性 API**（Tencent，异步 job），不交给 LLM（ADR-0002）。领域词条见 [CONTEXT.md § 抽取与分析](../../../CONTEXT.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `tencent_mark.ts` / `tencent_mark_parser.ts` | Tencent 试题批改 Agent 调用 + 结果解析为 StructuredQuestion |
| `tencent_mark_errors.ts` | Tencent 错误码 → 领域错误映射 |
| `structure.ts` | layout_quality 启发式（`structured`/`partial`/`text_only`）|
| `vision.ts` | **救援（rescue）**：用户显式触发的 LLM Vision 抽取（Tier 2 haiku / Tier 3 sonnet）|
| `rescue.ts` | block-level rescue 编排（session 状态不变，仅替换单块）|
| `crop.ts` | 按 Tencent 坐标自动裁剪 figure → R2 asset |
| `figure_attach.ts` | 配图归属（`attached_to_index`，high/low confidence，可 PATCH 改 manual）|
| `enroll.ts` / `auto-enroll.ts` | 抽取结果挂知识点 / 自动登记 |
| `tagging.ts` | 题目标注 |
| `workflow-judge.ts` / `workflow-judge-config.ts` | 抽取工作流判定 config |

## 关键约束
- **session 状态机**单一守卫在 [`../session/ingestion.ts`](../session/ingestion.ts)：`uploaded→queued→extracting→extracted/partial/failed`，`extracted/partial` 可 `markReviewed()`→`reviewed`，`commitImport()`→`imported`（终态只读）；`failed` 可 `retryExtraction()`。五个写入位置（POST /api/ingestion、/extract、handler、/rescue、/import）都走它。
- ingestion session 现在是 `learning_session(type='ingestion')`，**不是**旧的独立 `ingestion_session` 表（已 DROP）。
- Tencent `tencent_grading` 结果是 **evidence only**，不作系统真相——JudgeTask 独立判分。

## ANTI-PATTERNS
- 救援是**显式、付费可见、用户授权**的——别做自动 cascade fallback。
- 别绕过 session 守卫直接改 status；别把结构化抽取交给 LLM（确定性 API only）。
