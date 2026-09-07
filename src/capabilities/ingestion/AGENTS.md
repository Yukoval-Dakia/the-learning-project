# src/capabilities/ingestion — 录入域

> 题目/材料进系统的通道：拍照/PDF/DOCX/手输 → R2 asset 留存 → OCR（Tencent / GLM-OCR）→ VLM 结构树 → 切块/标注/入库。错题是题目的标记，不是独立通道（D11）。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 路由/job/proposal/tool/ui 归属声明与加载入口 |
| `api/contracts.ts` | ingestion session、multipart 上传、blocks、SSE 与兼容动作的 wire schema |
| `api/*.ts` | sessions / pdf / docx / blocks / events / extract / import / make-paper / rescue / revert / assets / mistakes |
| `server/` | 抽取核心：Tencent/GLM OCR client、parser、structure、vision rescue、auto-enroll、tagging、session 守卫 |
| `server/proposal-appliers.ts` | `block_merge` / `image_candidate` accept applier |
| `ui/RecordPage.tsx` | 录入面（`/record`） |

## CONVENTIONS
- 抽取与付费边界见 [ADR-0002 的 2026-05-30 修订及 2026-07-07 成本更新](../../../docs/adr/0002-structured-extraction-vs-llm-analysis.md)：OCR 提供文字 hint，自动 `StructureTask` VLM 拥有结构；上传授权 baseline 抽取，额外付费 rescue 仍须显式授权。
- ingestion session 是 `learning_session(type='ingestion')`，状态机单一守卫在 `src/server/session/ingestion.ts`。
- multipart 上传走 Web 标准 `req.formData()`；SSE 事件流走 `/api/ingestion/[id]/events`。

## ANTI-PATTERNS
- 救援是显式、付费可见、用户授权的——别做自动 cascade fallback。
- 别绕过 session 守卫直接改 status。
- 别把 Tencent 判分结果当系统真相；JudgeTask 独立判分。
