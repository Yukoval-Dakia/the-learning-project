// M0 (YUK-313) — 新栈前端工程（Vite SPA）。root = web/；'@' 别名与 tsconfig 对齐
// 指向 ../src（capability ui 资产直接复用）；dev 经 proxy 打 Hono(:8787)。
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, '.'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, '../src') },
  },
  server: {
    port: 5173,
    // M1-T6 (YUK-314) 双栈分流：已迁到 Hono 的前缀走新栈(:8787)；其余 /api 兜底
    // 到旧 Next dev——manual tab 的 /api/mistakes、知识点选择的 /api/knowledge 等
    // 未迁路由仍由旧栈服务，随 M2+ 各域迁包逐条收编。旧栈端口坑：OrbStack 容器
    // 可能占着 :3000（next dev 会跳 :3001），必要时用 RW_OLD_STACK 覆盖。
    proxy: {
      '/api/ingestion': 'http://localhost:8787',
      '/api/assets': 'http://localhost:8787',
      '/api/agents': 'http://localhost:8787',
      '/api/health': 'http://localhost:8787',
      // M2 (YUK-316)：练习/复习链已迁 Hono；T7 拆除旧壳后 solve 链也切新栈
      //（正则 key——questions CRUD（题面读/列表）属 quiz 域，D16 出 M2 范围，
      // 留旧栈至 M5 收口）。
      '/api/review': 'http://localhost:8787',
      '/api/practice': 'http://localhost:8787',
      '^/api/questions/.*/solve': 'http://localhost:8787',
      // M3-T4 (YUK-317)：知识/笔记链已迁 Hono。/api/editing-session（⚖️ 争议行）
      // 与 /api/embedded-check（D6 墓碑）留旧栈 catch-all。
      '/api/knowledge': 'http://localhost:8787',
      '/api/notes': 'http://localhost:8787',
      '/api/artifacts': 'http://localhost:8787',
      '/api/hubs': 'http://localhost:8787',
      // M4-T5 (YUK-319/YUK-318)：统一收件箱 + 工作台聚合已落 Hono。
      '/api/proposals': 'http://localhost:8787',
      '/api/workbench': 'http://localhost:8787',
      // M5-T3 (YUK-321)：copilot 域收编新栈。
      '/api/copilot': 'http://localhost:8787',
      '/api/today': 'http://localhost:8787',
      '/api/teaching-sessions': 'http://localhost:8787',
      // M5-T4 (YUK-321)：observability 域收编新栈（admin 四页 + subjects + cost/today）。
      '/api/admin': 'http://localhost:8787',
      '/api/cost': 'http://localhost:8787',
      '/api': process.env.RW_OLD_STACK ?? 'http://localhost:3000',
    },
  },
  build: { outDir: 'dist' },
});
