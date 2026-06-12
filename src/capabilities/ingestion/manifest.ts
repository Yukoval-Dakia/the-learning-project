import { defineCapability } from '@/kernel/manifest';

export const ingestionCapability = defineCapability({
  name: 'ingestion',
  description:
    '录入：任何题目进系统的通道（拍照/PDF/DOCX/手输 → 原图留存 → OCR/VLM 三层提取 → 切块 → 标注 → 入库）。错题是题目的标记不是通道（D11）。',
  api: {
    // M1-T4 (YUK-314)：13 个 route 文件 / 14 条 method+path 声明，全部带 load
    // 懒加载 thunk（manifest 保持纯元数据，unit 分区不拉 db）。[id] 段由
    // server/app.ts 的 toHonoPath 转为 :id 并把捕获参数透传 handler 第二实参。
    routes: [
      {
        method: 'GET',
        path: '/api/ingestion',
        load: () => import('./api/sessions').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/ingestion',
        load: () => import('./api/sessions').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/pdf',
        load: () => import('./api/pdf').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/docx',
        load: () => import('./api/docx').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/ingestion/[id]/blocks',
        load: () => import('./api/blocks').then((m) => m.GET),
      },
      {
        // SSE 首例：fetch + ReadableStream 消费端带标准 x-internal-token header
        // （src/ui/lib/sse.ts 从不使用 EventSource），token gate 无需任何豁免。
        method: 'GET',
        path: '/api/ingestion/[id]/events',
        load: () => import('./api/events').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/extract',
        load: () => import('./api/extract').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/import',
        load: () => import('./api/import').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/make-paper',
        load: () => import('./api/make-paper').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/rescue',
        load: () => import('./api/rescue').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/revert',
        load: () => import('./api/revert').then((m) => m.POST),
      },
      {
        // multipart 首例：handler 内 req.formData()（Web 标准），Hono 直通。
        method: 'POST',
        path: '/api/assets',
        load: () => import('./api/assets').then((m) => m.POST),
      },
      {
        method: 'DELETE',
        path: '/api/assets/[id]',
        load: () => import('./api/asset-delete').then((m) => m.DELETE),
      },
      {
        method: 'GET',
        path: '/api/assets/[id]/content',
        load: () => import('./api/asset-content').then((m) => m.GET),
      },
    ],
  },
  // M4-T4 (YUK-319)：proposal kind 归属声明。block_merge 的 accept applier 真身
  // 在 ./server/proposal-appliers（YUK-202 path-B，等价平移自 dispatch 壳）；
  // image_candidate 的在 ./server/image-candidate-accept（YUK-227 S3 Slice C，
  // 整文件随包迁入）。壳层 actions.ts 的 accept case 只路由到本包。
  proposals: {
    kinds: [{ kind: 'block_merge' }, { kind: 'image_candidate' }],
  },
  // M1-T6：录入面（学习记录 mode 按 D11 不迁）。
  ui: { pages: [{ route: '/record' }] },
  // M5-T3 (YUK-321) — copilot 工具归属声明。D11 已裁 record 渐废（裁决 d）：
  // 两工具等价平移不删；record 域退役时随本声明一并摘除（查 spec §1 D11 行）。
  copilotTools: {
    tools: [
      {
        name: 'query_records',
        load: () => import('@/server/ai/tools/context-readers').then((m) => m.queryRecordsTool),
      },
      {
        name: 'get_record_context',
        load: () => import('@/server/ai/tools/context-readers').then((m) => m.getRecordContextTool),
      },
    ],
  },
});
