// M0 (YUK-313) — 新栈 API 入口：loadEnv → 组合根挂载 → Hono serve。
// dev: `pnpm rw:api`（tsx watch）。prod 形态（standalone/docker）在 M5 拆除旧栈时定稿。
// M1-T5 (YUK-314)：RW_WORKER=1（rw:api 默认开）时同进程启动 pg-boss worker —— 新栈
// dev 是单进程拓扑（API + worker 一个进程），旧 worker（pnpm worker:dev）在 M1 期间
// 仍可独立运行（两者共用 startBossWorker 配方，队列层面共存无冲突）。

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { capabilities } from '@/capabilities';
import { resolveApiPort } from '@/server/env';
import { warnFlipOrder } from '@/server/projections/sot-flag';
import { buildHonoApp } from './app';
import { loadApiEnv } from './env';
import { installApiShutdown } from './shutdown';

const env = loadApiEnv();
// YUK-548: boot-time SoT-flip flag vector + flip-order WARN (never throws — see warnFlipOrder).
warnFlipOrder();

// YUK-345 / YUK-1007：API_PORT 解析单一真源在 src/server/env.ts resolveApiPort
// （trim → 空→默认 8787 → 非正整数 throw；admin config 读面 runtime 分区同源）。
const port = resolveApiPort(env.API_PORT);
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

// YUK-1007 — 配置面 hydrate + 15s 周期 refresh（app 侧挂载点，grounding §5.1 序
// 4/5）。never-throws：hydrate 内部自带 env/code-default 地板；这里再包一层
// try/catch 双保险。刷新句柄交给 shutdown（server 停下时 clearInterval——dev
// tsx watch 重启时若不清会漏到旧模块域）。
let configRefresh: { stop: () => void } | undefined;
async function hydrateConfigBeforeServe(): Promise<void> {
  try {
    const [{ db }, { hydrateConfigFromDb, startConfigRefresh }] = await Promise.all([
      import('@/db/client'),
      import('@/server/config/hydrate'),
    ]);
    const report = await hydrateConfigFromDb(db);
    console.log(
      `[rw:api] config hydrated: +${report.hydrated.length} keys (epoch ${report.epoch}${report.skipped.length ? `, skipped ${report.skipped.length}` : ''})`,
    );
    configRefresh = startConfigRefresh(db, 15_000);
  } catch (err) {
    console.warn('[rw:api] config hydration failed — serving with env/code-default floor', err);
  }
}

// M5-T5b (YUK-321) — prod 静态面：RW_STATIC_DIR 指向 vite build 产物（web/dist）。
// dev 不设此变量（Vite dev server 承担静态 + /api proxy）。serveStatic 未命中
// 文件时 next() 放行 /api/*；catch-all GET 回 index.html（TanStack Router
// 客户端路由 fallback），注册在 manifest 路由之后所以不抢任何 API 端点。
if (env.RW_STATIC_DIR) {
  const root = env.RW_STATIC_DIR;
  app.use('*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
}

async function registerToolsBeforeServe(): Promise<void> {
  const { registerCapabilityTools } = await import('@/server/ai/tools/register-capability-tools');
  await registerCapabilityTools(capabilities);
  console.log('[rw:api] capability tools registered');
}

// YUK-1007 — admin config 读面的运行时事实注入（providers[] / infra schedules /
// runtime 常量 / consumer-effective 值）。组合根（本进程）聚合一切真相源后经
// observability/public setter 注入**工厂**：route 每请求重调，跟随 env/热加载
// store 保持新鲜。必须在首个请求前完成（serve 前）；未注入时读面如实标
// facts_injected=false。动态 import：facts 模块链含 db/client（顶层读
// DATABASE_URL），须在 loadApiEnv() 之后加载。
async function injectAdminConfigFactsBeforeServe(): Promise<void> {
  try {
    const [{ buildAdminConfigRuntimeFacts }, { setAdminConfigRuntimeFacts }] = await Promise.all([
      import('@/server/config/admin-config-facts'),
      import('@/capabilities/observability/public'),
    ]);
    setAdminConfigRuntimeFacts(buildAdminConfigRuntimeFacts);
  } catch (err) {
    // 注入失败不拖死 API 面：读面照常服务（facts 分区如实标未注入）。
    console.warn('[rw:api] admin config facts injection failed — read face serves uninjected', err);
  }
}

async function injectAdminConfigWriterBeforeServe(): Promise<void> {
  try {
    const [{ createAdminConfigWriter }, { setAdminConfigWriter }] = await Promise.all([
      import('@/server/config/admin-config-write'),
      import('@/capabilities/observability/public'),
    ]);
    setAdminConfigWriter(createAdminConfigWriter());
  } catch (error) {
    console.warn('[rw:api] config writer unavailable — writes return 503', error);
  }
}

async function recoverToolOperationsBeforeServe(): Promise<void> {
  const [{ db }, { recoverToolOperationsOnBoot }] = await Promise.all([
    import('@/db/client'),
    import('@/kernel/tools/tool-operations'),
  ]);
  await recoverToolOperationsOnBoot(db);
}

async function startInProcessWorker(): Promise<void> {
  // db client / boss 在 loadEnv() 之后才能 import（模块顶层读 DATABASE_URL），
  // 所以走动态 import，不进文件头 import 区。
  const [{ db }, { startBossWorker }] = await Promise.all([
    import('@/db/client'),
    import('@/server/boss/start-worker'),
  ]);
  await startBossWorker(db);
  console.log('[rw:api] in-process pg-boss worker running (RW_WORKER=1)');
}

// esbuild CJS 禁 top-level await → async IIFE 形态（v2 §4 成文）。YUK-328：
// subjects hydrate + 完整 DomainTool manifest 注册都必须先于 serve；否则首个 AI
// 请求可能观测到半空 registry。RW_WORKER 同样只在注册完成后启动。
// 工具声明/load 错误 fail-fast，不暴露缺工具的残缺 API 面。
void (async () => {
  await hydrateSubjectsBeforeServe();
  await hydrateConfigBeforeServe();
  await registerToolsBeforeServe();
  await recoverToolOperationsBeforeServe();
  await injectAdminConfigFactsBeforeServe();
  await injectAdminConfigWriterBeforeServe();
  const server = serve({ fetch: app.fetch, port }, (info) => {
    const mounted = capabilities.flatMap((c) =>
      (c.api?.routes ?? []).filter((r) => r.load).map((r) => `${r.method} ${r.path}`),
    );
    console.log(`[rw:api] hono listening on :${info.port}`);
    console.log(`[rw:api] mounted from manifests: ${mounted.join(', ') || '(none)'}`);
  });

  let workerStartup: Promise<void> | undefined;
  installApiShutdown(server, async () => {
    // Wait for a worker that was still registering when the signal arrived.
    // HTTP is already drained, so no request can lazily start another boss.
    await workerStartup;
    const [{ db }, { getRunningBoss }, { stopBossGracefully }] = await Promise.all([
      import('@/db/client'),
      import('@/server/boss/client'),
      import('@/server/boss/shutdown'),
    ]);
    try {
      const boss = getRunningBoss();
      if (boss) await stopBossGracefully(boss, 'API shutdown');
    } finally {
      configRefresh?.stop();
      await db.$client.end({ timeout: 3 });
    }
  });

  if (env.RW_WORKER === '1') {
    workerStartup = startInProcessWorker().catch((err) => {
      // worker 起不来不该拖死 API 面：日志醒目 + API 继续服务（上传仍可用，
      // 只是 job 不被消费）；dev 下看到这条就修。
      console.error('[rw:api] in-process worker failed to start — jobs will NOT be consumed', err);
    });
  }
})().catch((err) => {
  console.error('[rw:api] startup failed before listen', err);
  process.exit(1);
});
