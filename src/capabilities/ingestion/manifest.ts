import { defineCapability } from '@/kernel/manifest';

export const ingestionCapability = defineCapability({
  name: 'ingestion',
  description:
    '录入：任何题目进系统的通道（拍照/PDF/DOCX/手输 → 原图留存 → OCR/VLM 三层提取 → 切块 → 标注 → 入库）。错题是题目的标记不是通道（D11）。API 路由在 M1-T4 携带 load 挂载。',
  // api.routes 在 T4（API 簇迁包）时补全并带 load thunk。
});
