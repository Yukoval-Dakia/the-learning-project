// M0 (YUK-313) — 新栈 API 入口：loadEnv → 组合根挂载 → Hono serve。
// dev: `pnpm rw:api`（tsx watch）。prod 形态（standalone/docker）在 M5 拆除旧栈时定稿。
// M1-T5 (YUK-314)：RW_WORKER=1（rw:api 默认开）时同进程启动 pg-boss worker —— 新栈
// dev 是单进程拓扑（API + worker 一个进程），旧 worker（pnpm worker:dev）在 M1 期间
// 仍可独立运行（两者共用 startBossWorker 配方，队列层面共存无冲突）。

import { capabilities } from '@/capabilities';
import { assertAgentSdkRuntimeUser } from '@/server/ai/runtime-preflight';
import { warnFlipOrder } from '@/server/projections/sot-flag';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { buildHonoApp } from './app';
import { loadEnv } from './env';

loadEnv();
assertAgentSdkRuntimeUser();
// YUK-548: boot-time SoT-flip flag vector + flip-order WARN (never throws — see warnFlipOrder).
warnFlipOrder();

// YUK-345: `??` only guards null/undefined, so a bare `API_PORT=` (dotenv loads
// it as '') would make Number('') === 0 → listen(0) binds a RANDOM port instead
// of 8787. Trim-then-empty-check + positive-integer guard mirrors the
// `optionalEnv` (trim → empty=default) fix applied to the mem0 config side in
// YUK-341. This is the only remaining `Number(process.env.X ?? ...)` site.
const rawApiPort = process.env.API_PORT?.trim();
const parsedApiPort = rawApiPort ? Number(rawApiPort) : 8787;
if (!Number.isInteger(parsedApiPort) || parsedApiPort <= 0) {
  throw new Error(`API_PORT must be a positive integer, got: ${JSON.stringify(rawApiPort)}`);
}
const port = parsedApiPort;
const app = buildHonoApp(capabilities);

// YUK-599（v2 §4 / v3 §2.2）— hydrate-before-serve：serve 前把 DB 六表装配水合进
// SubjectRegistry（custom 科目 + owner 编辑过的 builtin 装配在首个请求前就位）。
// never-throws：表未建（42P01）/ DB down → hydrate 内部 WARN + 四代码种子地板，
// 本函数恒 resolve——启动失败矩阵（v2 §4.4）不允许水合拖死 API 面。
// db client 必须 loadEnv() 之后才 import（模块顶层读 DATABASE_URL）→ 动态 import。
async function hydrateSubjectsBeforeServe(): Promise<void> {
  try {
    const [{ db }, { hydrateSubjectRegistryFromDb }] = await Promise.all([
      import('@/db/client'),
      import('@/server/subjects/hydrate'),
    ]);
    const report = await hydrateSubjectRegistryFromDb(db);
    const skippedNote = report.skipped.length > 0 ? ` (skipped ${report.skipped.length})` : '';
    console.log(`[rw:api] subjects hydrated: +${report.hydrated.length}${skippedNote}`);
  } catch (err) {
    console.warn('[rw:api] subject hydration failed — serving with code-seed floor', err);
  }
}

// M5-T5b (YUK-321) — prod 静态面：RW_STATIC_DIR 指向 vite build 产物（web/dist）。
// dev 不设此变量（Vite dev server 承担静态 + /api proxy）。serveStatic 未命中
// 文件时 next() 放行 /api/*；catch-all GET 回 index.html（TanStack Router
// 客户端路由 fallback），注册在 manifest 路由之后所以不抢任何 API 端点。
if (process.env.RW_STATIC_DIR) {
  const root = process.env.RW_STATIC_DIR;
  app.use('*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
}

async function registerToolsBeforeServe(): Promise<void> {
  const { registerCapabilityTools } = await import('@/server/ai/tools/register-capability-tools');
  await registerCapabilityTools(capabilities);
  console.log('[rw:api] capability tools registered');
}

async function startInProcessWorker(): Promise<void> {
  // db client / boss 在 loadEnv() 之后才能 import（模块顶层读 DATABASE_URL），
  // 所以走动态 import，不进文件头 import 区。
  const [{ db }, { startBossWorker }, { installShutdownHandler }] = await Promise.all([
    import('@/db/client'),
    import('@/server/boss/start-worker'),
    import('@/server/boss/shutdown'),
  ]);
  const boss = await startBossWorker(db);
  installShutdownHandler(boss);
  console.log('[rw:api] in-process pg-boss worker running (RW_WORKER=1)');
}

// esbuild CJS 禁 top-level await → async IIFE 形态（v2 §4 成文）。YUK-328：
// subjects hydrate + 完整 DomainTool manifest 注册都必须先于 serve；否则首个 AI
// 请求可能观测到半空 registry。RW_WORKER 同样只在注册完成后启动。
// 工具声明/load 错误 fail-fast，不暴露缺工具的残缺 API 面。
void (async () => {
  await hydrateSubjectsBeforeServe();
  await registerToolsBeforeServe();
  serve({ fetch: app.fetch, port }, (info) => {
    const mounted = capabilities.flatMap((c) =>
      (c.api?.routes ?? []).filter((r) => r.load).map((r) => `${r.method} ${r.path}`),
    );
    console.log(`[rw:api] hono listening on :${info.port}`);
    console.log(`[rw:api] mounted from manifests: ${mounted.join(', ') || '(none)'}`);
  });

  if (process.env.RW_WORKER === '1') {
    void startInProcessWorker().catch((err) => {
      // worker 起不来不该拖死 API 面：日志醒目 + API 继续服务（上传仍可用，
      // 只是 job 不被消费）；dev 下看到这条就修。
      console.error('[rw:api] in-process worker failed to start — jobs will NOT be consumed', err);
    });
  }
})().catch((err) => {
  console.error('[rw:api] startup failed before listen', err);
  process.exit(1);
});
