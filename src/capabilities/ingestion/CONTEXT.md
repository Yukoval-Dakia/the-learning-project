# ingestion — 录入（M1 采伐，YUK-314）

任何题目进系统的通道（D11：错题是标记不是通道）。链路：上传（图/PDF/DOCX）→ 原图留存 R2
（不变量）→ OCR/VLM 三层提取（专用 OCR 默认 → VLM 兜底 → heavy）→ 题目块组装切分 →
知识点标注 → 渐进式入库（观察模式默认）。

- server/ — 管线本体（structure/tagging/block-assembly/enroll/auto-enroll/rescue/
  pdf-render/docx/ 双线/glm_ocr/tencent_mark/vision/workflow-judge/make-paper 等，
  测试同居命名即分区）
- jobs/ — tencent_ocr_extract / auto_enroll（M1-T3 迁入；旧 worker registry 仍挂载它们）
- api/ — 13 个 route 文件 / 14 条 method+path（M1-T4 迁入；manifest load thunk 经
  server/app.ts 挂 Hono；旧 Next 壳 shim 双栈期保留至 T7）
- ui/ — RecordPage（M1-T6；学习记录 mode 按 D11 不迁；路由 props 注入，
  web/src/router.tsx 挂 /record；/api/mistakes、/api/knowledge 等未迁路由
  dev 下经 vite proxy 兜底旧栈）
- 迁移期豁免：仍 import 遗留 @/server/r2、@/server/events、@/server/ai/*、@/db/*。
- AGENTS.md 为采伐前历史文档随簇保留。
