# ingestion — 录入（M1 采伐，YUK-314）

任何题目进系统的通道（D11：错题是标记不是通道）。链路：上传（图/PDF/DOCX）→ 原图留存 R2
（不变量）→ OCR/VLM 三层提取（专用 OCR 默认 → VLM 兜底 → heavy）→ 题目块组装切分 →
知识点标注 → 渐进式入库（观察模式默认）。

- server/ — 管线本体（structure/tagging/block-assembly/enroll/auto-enroll/rescue/
  pdf-render/docx/ 双线/glm_ocr/tencent_mark/vision/workflow-judge/make-paper 等，
  测试同居命名即分区）

**make-paper 语义（owner 2026-06-05 拍板，源：`docs/archive/superpowers/plans/2026-06-05-strategy-d-s1-ingest-practice-bridge.md` §13）**：录入完成后**不自动组卷、不自动进 FSRS**——组卷是显式 `POST /api/ingestion/[id]/make-paper` 动作；任何 imported session 可组卷，默认打包**全部 imported question**（整卷复现语义），`question_ids` 提供即须非空。

**OCR 双引擎永久保留（owner 2026-06-07 拍板「不删」，源：`docs/archive/superpowers/plans/2026-06-07-yuk253-glm-ocr-swap.md`）**：GLM-OCR 为默认引擎后，Tencent 引擎（`tencent_mark*`）与 `EXTRACT_OCR_ENGINE` 切换**永久保留可切换，无删除计划**（rollback 之外的长期第二引擎，不是 phase-deferred 临件）；queue 名 `tencent_ocr_extract` 冻结。
- jobs/ — tencent_ocr_extract / auto_enroll（M1-T3 迁入；旧 worker registry 仍挂载它们）
- api/ — 13 个 route 文件 / 14 条 method+path（M1-T4 迁入；manifest load thunk 经
  server/app.ts 挂 Hono；旧 Next 壳 shim 双栈期保留至 T7）
- ui/ — RecordPage（M1-T6；学习记录 mode 按 D11 不迁；路由 props 注入，
  web/src/router.tsx 挂 /record；/api/mistakes、/api/knowledge 等未迁路由
  dev 下经 vite proxy 兜底旧栈）
- 迁移期豁免：仍 import 遗留 @/server/r2、@/server/events、@/server/ai/*、@/db/*。
- AGENTS.md 为采伐前历史文档随簇保留。
