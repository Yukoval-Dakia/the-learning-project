# ingestion — OCR / 抽取 pipeline

> 用户上传材料 → 抽取 → 落库的服务层。OCR 提供文字 hint，自动 VLM 生成规范结构树；baseline / rescue 授权边界见上级 [AGENTS.md](../AGENTS.md)。领域词条见 [CONTEXT.md § 抽取与分析](../../../../CONTEXT.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `tencent_mark.ts` / `tencent_mark_parser.ts` | Tencent 试题批改 Agent 调用 + 结果解析为 StructuredQuestion |
| `tencent_mark_errors.ts` | Tencent 错误码 → 领域错误映射 |
| `structure.ts` | `runStructureTask`：全页图片与 OCR hint → 跨页结构树及题图归属 |
| `../jobs/tencent_ocr_extract.ts` | OCR → VLM baseline 编排；VLM 失败时使用已有 OCR 结果降级，不升级付费 rescue |
| `vision.ts` | 用户显式 rescue 的 Vision 调用与解析；模型选择以 TaskSpec / 当前配置为准 |
| `rescue.ts` | block-level rescue 编排（session 状态不变，仅替换单块）|
| `crop.ts` | 按 Tencent 坐标自动裁剪 figure → R2 asset |
| `figure_attach.ts` | 配图归属（`attached_to_index`，high/low confidence，可 PATCH 改 manual）|
| `enroll.ts` / `auto-enroll.ts` | 抽取结果挂知识点 / 自动登记 |
| `tagging.ts` | 题目标注 |
| `workflow-judge.ts` / `workflow-judge-config.ts` | 抽取工作流判定 config |

## 关键约束
- **session 状态机**：修改抽取、复核、导入或重试行为时，使用 [`src/server/session/ingestion.ts`](../../../server/session/ingestion.ts) 的守卫维护状态转换与终态只读约束。
- ingestion session 现在是 `learning_session(type='ingestion')`，**不是**旧的独立 `ingestion_session` 表（已 DROP）。
- Tencent `tencent_grading` 结果是 **evidence only**，不作系统真相——JudgeTask 独立判分。

## ANTI-PATTERNS
- 救援是**显式、付费可见、用户授权**的——别做自动 cascade fallback。
- 别绕过 session 守卫直接改 status。
