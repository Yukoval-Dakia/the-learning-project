// YUK-1529 — worksheet_render job：服务端无头 Chromium 渲染作答卷。
//
// 流程（与 UI 线验证过的渲染配方逐字一致）：
//   1. playwright-core 开 /print/worksheet/<token>（Asia/Tokyo context，
//      emulateMedia print 在导航之前 —— 不设 print media 隐藏测量区没有
//      布局，量出的区域图是错的）；
//   2. 等 <html data-worksheet-state="ready">；error/layout_overflow 如实失败；
//   3. 同一页面调 window.__tlpWorksheetRegionMap() 拿区域图；
//   4. 同一页面 page.pdf()；
//   5. 对象级 canonicalize（抹掉 Chromium 每次渲染都打上的墙钟元数据）→ sha256
//      → pdf_digest；
//   6. PDF 写 R2（content-addressed key，重跑安全）；
//   7. 走 #1773 既有 archiveWorksheetRegionMap write-once 存档：
//      同图同 digest ⇒ existing，异 ⇒ 冲突如实抛出。
//
// 网络边界（R1 P1-2）：
//   - context.route('**/*') 对同源请求走 route.fetch({ maxRedirects: 0 }) —
//     Playwright 自动跟随 3xx 时不会再进 route handler，同源页面 302 到外站
//     会绕过 allowlist；拿到原始 3xx 后显式裁决 Location，离站即 abort 并记录；
//   - context.routeWebSocket 关掉一切非本站 socket 并记录（vite HMR 等同站 ws
//     照常双向透传）；
//   - serviceWorkers: 'block' —— SW 可持缓存绕过 route 拦截，一律禁掉；
//   - init script 只在 location.origin === 受信 origin 时才写 internal token；
//   - render origin 只许内部宿主（loopback 或 compose 'app' 服务名），job 数据
//     里也不接受任意 URL。
//   被 abort 的 URL 全部进 job 结果的 aborted_urls —— 泄漏可见。
//
// 挂死保护（R1 P1-4）：整段浏览器过程有一个总 deadline（远小于 agent 档 2h
// expire），并监听 pg-boss job.signal；任一触发即主动 browser.close()（挂起的
// page 操作随之 reject），job 诚实失败且不存档；finally 兜底关 browser。
//
// 不存半档：任何一步失败都不存档；blob 已写但存档失败时错误信息带留下的
// content-addressed key。
//
// 本 job 不调任何模型，零成本。Chromium 只在 worker 镜像（Dockerfile worker
// stage），app 镜像不变。

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Job } from 'pg-boss';
import type { Browser as ChromiumBrowser, Page as ChromiumPage } from 'playwright-core';

import type { WorksheetRegionMapArchiveBodyT } from '@/capabilities/practice/api/worksheet-contracts';
import { WorksheetRegionMapArchiveBody } from '@/capabilities/practice/api/worksheet-contracts';
import {
  type ArchiveRegionMapResult,
  archiveWorksheetRegionMap,
} from '@/capabilities/practice/server/worksheet/export-store';
import {
  type WorksheetPdfVerification,
  WorksheetRenderPermanentError,
  canonicalizeWorksheetPdf,
  verifyWorksheetPdf,
} from '@/capabilities/practice/server/worksheet/pdf-fidelity';
import {
  putWorksheetExportPdf,
  worksheetPdfBlobKey,
} from '@/capabilities/practice/server/worksheet/pdf-store';
import type { Db } from '@/db/client';

// src/ui/lib/api.ts TOKEN_STORAGE_KEY —— 打印页的 /api 调用从这里读 token。
const TOKEN_STORAGE_KEY = 'loom_internal_token';

// R1/CI-1：tests/dbos-* 等 harness 用自己的 --external 清单 esbuild 打 worker
// entry —— 静态 import 会把 chromium-bidi 内部文件拖进那些 bundle 里
// `Could not resolve`。运行期 lazy require 让所有 bundler 都看不到它；
// dist/worker.cjs 在 worker 镜像里从 flat COPY 的 node_modules 解析。
// 锚点用 cwd/package.json（文件不必存在，只取目录）：worker 容器 WORKDIR=/app
// → /app/node_modules；dev/tsx cwd=repo root → ./node_modules。不用
// import.meta.url —— esbuild cjs 输出把它 shim 成空对象；不用 __filename ——
// "type": "module" 下 tsx/vitest 里没有这个名字。
type PlaywrightCore = typeof import('playwright-core');
const requireFromHere = createRequire(join(process.cwd(), 'package.json'));
let playwrightCore: PlaywrightCore | null = null;
function loadPlaywrightCore(): PlaywrightCore {
  playwrightCore ??= requireFromHere('playwright-core') as PlaywrightCore;
  return playwrightCore;
}

const NAV_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 120_000;
/** 整段浏览器 pass 的总 deadline：3 分钟 —— 远低于 agent 档 2h 队列过期，
 * 真实渲染在秒级，超此上限只能是挂死；触发即关 browser 并诚实失败。 */
const RENDER_DEADLINE_MS = 180_000;

// ---------- 渲染 origin 只允许内部宿主（R1 P1-2） ----------

/** loopback 与 compose 内部服务名；不接受来自 job 数据或 env 的任意外站。 */
const ALLOWED_RENDER_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'app']);

function resolveRenderOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorksheetRenderPermanentError(
      `worksheet_render: render origin '${raw}' is not a URL`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WorksheetRenderPermanentError(
      `worksheet_render: render origin '${raw}' must be http(s)`,
    );
  }
  if (!ALLOWED_RENDER_HOSTNAMES.has(url.hostname)) {
    throw new WorksheetRenderPermanentError(
      `worksheet_render: render origin host '${url.hostname}' is not an internal host ` +
        '(allowed: loopback or the compose "app" service)',
    );
  }
  return url.origin;
}

// ---------- PDF 字节解析 / canonicalize / 产物验真 → server/worksheet/pdf-fidelity.ts ----------
//
// YUK-1572：约 1200 行纯算法（classic xref/页树、内容流解释器、canonicalize、
// 锚点/A4/页数硬校验）迁至 server/worksheet/pdf-{structure,content,fidelity}.ts；
// 以下 re-export 保持既有导入路径兼容，实现与错误时序逐字未动。

export type {
  WorksheetAnchorMeasurement,
  WorksheetPageVerification,
  WorksheetPdfVerification,
} from '@/capabilities/practice/server/worksheet/pdf-fidelity';
export {
  WorksheetRenderPermanentError,
  canonicalizeWorksheetPdf,
  verifyWorksheetPdf,
} from '@/capabilities/practice/server/worksheet/pdf-fidelity';

/** window.__tlpWorksheetRegionMap() 的返回形状（ui/worksheet-measure.ts 的
 * WorksheetRegionMapDraft —— 存档体减 pdf_digest）。 */
export type WorksheetRegionMapDraft = Omit<WorksheetRegionMapArchiveBodyT, 'pdf_digest'>;

export interface WorksheetPageRender {
  /** canonicalize 后的 PDF 字节（写入 R2、digest 的对象）。 */
  pdf: Buffer;
  /** 页面内量出的区域图（WorksheetRegionMapArchiveBody 减 pdf_digest）。 */
  regionMap: WorksheetRegionMapDraft;
  /** 被网络边界拦下的非本站请求/跳转/WS（job 结果带出，泄漏可见）。 */
  abortedUrls: string[];
}

async function readPageState(
  page: ChromiumPage,
): Promise<{ state: string | null; error: string | null } | null> {
  try {
    return await page.evaluate(() => ({
      state: document.documentElement.getAttribute('data-worksheet-state'),
      error: document.documentElement.getAttribute('data-worksheet-error'),
    }));
  } catch {
    return null;
  }
}

/** 渲染一份作答卷：开打印页 → 等就绪 → 量区域图 → page.pdf()。
 * `opts.signal` = pg-boss job.signal；`opts.deadlineMs` = 整段浏览器 pass 的
 * 总时限（缺省 RENDER_DEADLINE_MS）。任一触发 ⇒ 主动关 browser，挂起操作
 * reject，诚实失败。 */
export async function renderWorksheetPage(
  input: {
    appOrigin: string;
    exportToken: string;
    internalToken: string;
  },
  opts: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<WorksheetPageRender> {
  const appOrigin = resolveRenderOrigin(input.appOrigin);
  const deadlineMs = opts.deadlineMs ?? RENDER_DEADLINE_MS;
  const abortedUrls: string[] = [];
  // 路由回调内部异常（route.fetch reject 等）。回调不能 throw —— 那会变成
  // 进程级 unhandledRejection —— 但回调失败意味着渲染可能不完整，必须让
  // 整段渲染诚实失败，而不是带着缺资源的页面去存档。收进来、收尾裁决。
  const callbackFailures: string[] = [];

  let browser: ChromiumBrowser | null = null;
  let deadlineHit = false;
  const killBrowser = () => {
    void browser?.close().catch(() => {});
  };
  const timer = setTimeout(() => {
    deadlineHit = true;
    killBrowser();
  }, deadlineMs);
  const onJobSignal = () => killBrowser();
  opts.signal?.addEventListener('abort', onJobSignal, { once: true });

  try {
    browser = await loadPlaywrightCore().chromium.launch();
    const context = await browser.newContext({
      timezoneId: 'Asia/Tokyo',
      // SW 可持缓存绕过 route 拦截 —— 一律禁掉。
      serviceWorkers: 'block',
    });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      try {
        // data:/blob:/about: 不出本进程 —— 站点图床（object URL）与内联资源走这里。
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
          // 必须 return await —— 直接 return 未 await 的 promise，其 reject
          // 会逃出 try/catch 重新变成 unhandled rejection。
          return await route.continue();
        }
        if (new URL(url).origin !== appOrigin) {
          abortedUrls.push(url);
          return await route.abort('blockedbyclient');
        }
        // maxRedirects: 0 —— Playwright 自动跟随 3xx 时不会再进本 handler，
        // 同源页面 302 到外站会绕过 allowlist。拿原始 3xx 显式裁决 Location；
        // 同源跳转则由浏览器继续发出下一跳、重新进本 handler 过滤。
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers().location;
        if (response.status() >= 300 && response.status() < 400 && location != null) {
          const target = new URL(location, url);
          if (target.origin !== appOrigin) {
            abortedUrls.push(`${url} -> ${target.href}`);
            return await route.abort('blockedbyclient');
          }
        }
        return await route.fulfill({ response });
      } catch (error) {
        // Grok QA P1-2：route.fetch 在 app 不可达时 reject，未接住的回调 reject
        // 会变成 worker 进程的 unhandledRejection → 整个 worker 连同其他队列的
        // in-flight job 一起被杀。catch 住、记录、abort（自身也 guard），让请求
        // 经 page.goto/资源失败走正常诚实失败路径。
        const message = `${url} (route fetch failed: ${error instanceof Error ? error.message : String(error)})`;
        abortedUrls.push(message);
        callbackFailures.push(message);
        await route.abort('failed').catch(() => {});
        return undefined;
      }
    });
    // WebSocket 不经 route() —— 单独拦：非本站一律关掉并记录。回调内任何异常
    // 同样不能漏成 unhandledRejection（P1-2）。
    await context.routeWebSocket(
      () => true,
      (ws) => {
        try {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(ws.url()).origin === appOrigin;
          } catch {
            sameOrigin = false;
          }
          if (!sameOrigin) {
            abortedUrls.push(`ws:${ws.url()}`);
            ws.close();
            return;
          }
          const server = ws.connectToServer();
          ws.onMessage((message) => {
            try {
              server.send(message);
            } catch {
              /* socket 已关，丢弃 */
            }
          });
          server.onMessage((message) => {
            try {
              ws.send(message);
            } catch {
              /* socket 已关，丢弃 */
            }
          });
        } catch (error) {
          const message = `ws:${ws.url()} (handler failed: ${error instanceof Error ? error.message : String(error)})`;
          abortedUrls.push(message);
          callbackFailures.push(message);
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        }
      },
    );
    // 打印页 apiFetch 从 localStorage 读 internal token（src/ui/lib/api.ts）；
    // 只在受信 origin 上才写入 —— 若页面被 302 带走，外站拿不到 token。
    await context.addInitScript(
      (args: { key: string; token: string; origin: string }) => {
        if (window.location.origin === args.origin) {
          window.localStorage.setItem(args.key, args.token);
        }
      },
      { key: TOKEN_STORAGE_KEY, token: input.internalToken, origin: appOrigin },
    );
    const page = await context.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.goto(`${appOrigin}/print/worksheet/${encodeURIComponent(input.exportToken)}`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    try {
      await page.waitForFunction(
        () => {
          const state = document.documentElement.getAttribute('data-worksheet-state');
          return state === 'ready' || state === 'error';
        },
        undefined,
        { timeout: READY_TIMEOUT_MS },
      );
    } catch (error) {
      const last = await readPageState(page);
      throw new Error(
        `worksheet render: timed out waiting for data-worksheet-state=ready after ${READY_TIMEOUT_MS}ms` +
          ` (last state=${last?.state ?? 'unreadable'}, error=${last?.error ?? 'none'})`,
        { cause: error },
      );
    }
    const outcome = await readPageState(page);
    if (outcome?.state !== 'ready') {
      // 页面失败码（WorksheetPrintPage.tsx ERROR_COPY）：
      // export_not_found / layout_overflow = 冻结输入决定，重跑必同果 → 永久；
      // load_failed / asset_failed = 可能瞬时 → 走 pg-boss 重试。
      const permanent =
        outcome?.error === 'export_not_found' || outcome?.error === 'layout_overflow';
      const message =
        `worksheet render: print page reported state=${outcome?.state ?? 'unreadable'}` +
        (outcome?.error ? ` error=${outcome.error}` : '');
      if (permanent) throw new WorksheetRenderPermanentError(message);
      throw new Error(message);
    }

    const regionMap = (await page
      .evaluate(() => {
        const measure = (window as { __tlpWorksheetRegionMap?: () => unknown })
          .__tlpWorksheetRegionMap;
        if (measure == null) {
          throw new Error('window.__tlpWorksheetRegionMap is not defined on a ready page');
        }
        return measure();
      })
      .catch((error: unknown) => {
        // ready 页但没有量图 hook = UI/job 版本错配 —— 确定性，永久分类。
        if (
          error instanceof Error &&
          error.message.includes('__tlpWorksheetRegionMap is not defined')
        ) {
          throw new WorksheetRenderPermanentError(
            'worksheet render: ready page has no __tlpWorksheetRegionMap hook (UI/job version mismatch)',
          );
        }
        throw error;
      })) as WorksheetRegionMapDraft;

    // Grok QA P1-1：隐藏测量区 .ws-stage-host（含 297mm 横向样张）若留在 DOM，
    // Chromium 会把 ≥3 页的卷面 shrink-to-fit ~0.73 —— 区域图仍按 1:1 存，PDF
    // 缩水，write-once 存档永久脏。先取图（上面）→ 移除 stage → 再出 PDF。
    const stageGone = await page.evaluate(() => {
      for (const el of document.querySelectorAll('.ws-stage-host')) el.remove();
      return document.querySelector('.ws-stage-host') === null;
    });
    if (!stageGone) {
      throw new WorksheetRenderPermanentError(
        'worksheet render: .ws-stage-host still in the DOM after removal',
      );
    }

    const rawPdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    let pdf: Buffer;
    try {
      pdf = canonicalizeWorksheetPdf(rawPdf);
    } catch (error) {
      // 字节级 canonicalize 失败同样确定性 → 永久分类。
      throw new WorksheetRenderPermanentError(
        `worksheet render: pdf canonicalize failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (callbackFailures.length > 0) {
      throw new Error(
        `worksheet render: ${callbackFailures.length} route callback failure(s) ` +
          `— render is untrusted: ${callbackFailures.slice(0, 5).join('; ')}`,
      );
    }
    return { pdf, regionMap, abortedUrls };
  } catch (error) {
    // 失败路径也带出被拦请求/回调失败 —— 渲染失败时 result 不落 job.output，
    // 泄漏记录不能随 result 一起丢。
    const leaks =
      (abortedUrls.length > 0 ? ` [aborted off-origin: ${abortedUrls.join(', ')}]` : '') +
      (callbackFailures.length > 0
        ? ` [route callback failures: ${callbackFailures.join('; ')}]`
        : '');
    if (opts.signal?.aborted) {
      throw new Error(`worksheet render aborted: pg-boss job signal fired${leaks}`, {
        cause: error,
      });
    }
    if (deadlineHit) {
      throw new Error(`worksheet render exceeded the ${deadlineMs}ms deadline${leaks}`, {
        cause: error,
      });
    }
    if (leaks !== '' && error instanceof Error) {
      // 追加细节时保持错误类别 —— PermanentError 换成普通 Error 会重新
      // 打开 pg-boss 重试（确定性失败白跑两次）。
      if (error instanceof WorksheetRenderPermanentError) {
        throw new WorksheetRenderPermanentError(`${error.message}${leaks}`, { cause: error });
      }
      throw new Error(`${error.message}${leaks}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onJobSignal);
    if (browser != null) await browser.close().catch(() => {});
  }
}

export type WorksheetRenderResult =
  | {
      status: 'archived' | 'existing';
      export_token: string;
      pdf_digest: string;
      blob_key: string;
      page_count: number;
      aborted_urls: string[];
      verification: WorksheetPdfVerification;
    }
  | {
      status: 'failed_permanent';
      export_token: string;
      reason: string;
    };

export async function runWorksheetRender(
  db: Db,
  input: { export_token: string },
  deps: { appOrigin?: string; internalToken?: string; signal?: AbortSignal } = {},
): Promise<WorksheetRenderResult> {
  try {
    const appOrigin =
      deps.appOrigin ?? process.env.WORKSHEET_RENDER_APP_ORIGIN?.trim() ?? 'http://localhost:5173';
    if (appOrigin === '') {
      throw new WorksheetRenderPermanentError(
        'worksheet_render: WORKSHEET_RENDER_APP_ORIGIN is empty',
      );
    }
    const internalToken = deps.internalToken ?? process.env.INTERNAL_TOKEN;
    if (!internalToken) {
      throw new WorksheetRenderPermanentError(
        'worksheet_render: INTERNAL_TOKEN is not set — the print page cannot authenticate its /api calls',
      );
    }

    const rendered = await renderWorksheetPage(
      { appOrigin, exportToken: input.export_token, internalToken },
      { signal: deps.signal },
    );

    const pdfDigest = `sha256:${createHash('sha256').update(rendered.pdf).digest('hex')}`;
    const parsed = WorksheetRegionMapArchiveBody.safeParse({
      ...rendered.regionMap,
      pdf_digest: pdfDigest,
    });
    if (!parsed.success) {
      // 同一份 DOM 必然量出同一张图 —— 契约不过属确定性，重跑无意义（永久）。
      throw new WorksheetRenderPermanentError(
        `worksheet render: measured region map fails the archive contract: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const body: WorksheetRegionMapArchiveBodyT = parsed.data;

    // 强制校验产物字节（页数/A4 MediaBox/无 shrink/定位点）——不过即渲染失败，
    // 此时尚未写 blob、未触碰存档：无半档、无孤儿。
    const verification = verifyWorksheetPdf(rendered.pdf, body);

    const blobKey = worksheetPdfBlobKey(pdfDigest);
    await putWorksheetExportPdf(pdfDigest, rendered.pdf);

    let out: ArchiveRegionMapResult;
    try {
      out = await archiveWorksheetRegionMap(db, input.export_token, body);
    } catch (error) {
      // write-once 冲突 / 并发抢存：存档事务已整体回滚（无半档），但 blob 已写。
      // content-addressed key ⇒ 同图重跑会原地覆盖，孤儿对象可判可清。
      // 冲突后可重试：同图重渲染 digest 相同 → 落 existing。
      throw new Error(
        `worksheet render: blob '${blobKey}' written but archive failed (orphaned blob, retry-safe): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    switch (out.status) {
      case 'archived':
      case 'existing':
        return {
          status: out.status,
          export_token: input.export_token,
          pdf_digest: pdfDigest,
          blob_key: blobKey,
          page_count: out.archive.page_count,
          aborted_urls: rendered.abortedUrls,
          verification,
        };
      case 'not_found':
        throw new WorksheetRenderPermanentError(
          `worksheet render: export '${input.export_token}' not found`,
        );
      case 'invalid_map':
        throw new WorksheetRenderPermanentError(
          `worksheet render: region map rejected by frozen-issuance validation: ${out.issues
            .map((issue) => `${issue.code}(${issue.detail})`)
            .join('; ')}`,
        );
    }
  } catch (error) {
    if (error instanceof WorksheetRenderPermanentError) {
      // 冻结输入的确定性失败 —— 完结 job 不 retry（P3），原因落 job.output。
      return {
        status: 'failed_permanent',
        export_token: input.export_token,
        reason: error.message,
      };
    }
    throw error;
  }
}

export function buildWorksheetRenderHandler(db: Db): (jobs: Job<unknown>[]) => Promise<unknown> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data as { export_token?: unknown } | null;
      if (typeof data?.export_token !== 'string' || data.export_token.length === 0) {
        throw new Error('worksheet_render: job payload must carry a non-empty export_token');
      }
      const result = await runWorksheetRender(
        db,
        { export_token: data.export_token },
        { signal: job.signal },
      );
      console.log('[worksheet_render]', JSON.stringify(result));
      // batchSize=1：返回值落 job.output（kernel JobHandlerFactory docblock）。
      return result;
    }
    return null;
  };
}
