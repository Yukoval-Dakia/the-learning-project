// M0 (YUK-313, 总 spec REV 2 §2.5) — Hono 应用工厂：组合根真实挂载。
// capability manifest 声明的路由（带 load 懒加载 thunk）在这里循环挂载——
// 路由注册从「元数据 + Next 壳文件」变为可执行代码，壳文件仪式消失（D19）。
// 鉴权沿用单用户不变量：/api/* 全拦 x-internal-token，/api/health 豁免。

import { createHash, timingSafeEqual } from 'node:crypto';

import type { CapabilityManifest, RouteHandler } from '@/kernel/manifest';
import { Hono } from 'hono';

/** Next 风格 '[id]' 段 → Hono ':id'。M0 无参路由用不到，转换器先行 + 单测钉住。 */
export function toHonoPath(path: string): string {
  return path.replace(/\[([^\]]+)\]/g, ':$1');
}

// Fail-closed token 比较（M5 全分支 review H1）：INTERNAL_TOKEN 未设 ⇒ 拒绝一切
// /api/* 请求（直接 `!==` 比较在「未设 + 缺 header」时 undefined !== undefined
// 为 false 会放行）。SHA-256 摘要定长后 timingSafeEqual——常时比较且不泄露长度，
// 语义对齐被 M5 拆除的 middleware.ts。
function tokenMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export function buildHonoApp(capabilities: CapabilityManifest[]): Hono {
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next();
    if (!tokenMatches(c.req.header('x-internal-token'), process.env.INTERNAL_TOKEN)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  for (const cap of capabilities) {
    for (const route of cap.api?.routes ?? []) {
      if (!route.load) continue;
      const load = route.load;
      // handler 缓存：首次请求解析一次，之后复用（避免每请求重复 dynamic import 开销）。
      let cached: Promise<RouteHandler> | undefined;
      app.on(route.method, toHonoPath(route.path), async (c) => {
        cached ??= load();
        // M1 (YUK-314)：路径参数透传——Hono 的 :id 捕获以 Record 形式交给 handler。
        return (await cached)(c.req.raw, c.req.param());
      });
    }
  }

  // 未命中的 /api/* 统一 404 JSON（M5 全分支 review M1）：注册在 manifest 路由
  // 之后只兜未匹配项——否则 prod 下穿透到 serveStatic catch-all 回 index.html 200，
  // 与 dev（Vite proxy → 404）行为分叉，掩盖打错的端点。
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  return app;
}
