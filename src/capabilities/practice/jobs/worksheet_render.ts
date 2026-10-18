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
    throw new Error(`worksheet_render: render origin '${raw}' is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`worksheet_render: render origin '${raw}' must be http(s)`);
  }
  if (!ALLOWED_RENDER_HOSTNAMES.has(url.hostname)) {
    throw new Error(
      `worksheet_render: render origin host '${url.hostname}' is not an internal host ` +
        '(allowed: loopback or the compose "app" service)',
    );
  }
  return url.origin;
}

// ---------- 对象级 PDF canonicalize（R1 P1-3） ----------
//
// Chromium（Skia/PDF）每次渲染都嵌入墙钟 CreationDate/ModDate（Info 对象），
// 部分版本还在 trailer 放随机 /ID —— 同一份 DOM 出两份不同字节，write-once
// 存档会把重跑误判成冲突。
//
// 这里做**对象感知**的同长度归一（绝不全文正则扫二进制流）：
//   a) 末尾 startxref → xref 表 → trailer 字典（平衡 <<>> 扫描），只改 trailer
//      里的 /ID [<hex><hex>]（十六进制位同长度置 0）；有 /Prev 增量链直接抛错；
//   b) trailer /Info N 0 R 指到的对象（按其 xref 偏移定位、endobj 截界）里，
//      只抹 /CreationDate (...) 与 /ModDate (...) 的括串内容（同长度定值）。
// 之后断言：输出长度 === 输入长度；xref 每个 n 条目偏移仍指向 `N G obj`。
// 任何一步不满足都抛错 —— 坏文件诚实失败，不猜、不放宽。

const CANONICAL_PDF_DATE = 'D:19700101000000Z';

/** 跳过当前行剩余部分（含行尾），返回下一行起点。 */
function skipLineEnd(text: string, cursor: number, what: string): number {
  const nl = text.indexOf('\n', cursor);
  if (nl < 0) throw new Error(`worksheet pdf canonicalize: unexpected EOF in ${what}`);
  return nl + 1;
}

export function canonicalizeWorksheetPdf(pdf: Buffer): Buffer {
  const text = pdf.toString('latin1');

  const startxrefIdx = text.lastIndexOf('startxref');
  if (startxrefIdx < 0) throw new Error('worksheet pdf canonicalize: no startxref marker');
  const tail = /^startxref\s+(\d+)\s+%%EOF/.exec(text.slice(startxrefIdx));
  if (tail == null) throw new Error('worksheet pdf canonicalize: malformed startxref/%%EOF tail');
  const xrefStart = Number(tail[1]);
  if (text.slice(xrefStart, xrefStart + 4) !== 'xref') {
    throw new Error(
      'worksheet pdf canonicalize: startxref does not point at a classic xref table ' +
        '(xref streams are unsupported — Chromium emits classic tables)',
    );
  }

  // --- xref 小节：object number → {offset, gen}，并记下每个 'n' 条目的位置待校验 ---
  const objects = new Map<number, { offset: number; gen: number }>();
  let cursor = skipLineEnd(text, xrefStart + 'xref'.length, 'xref keyword');
  for (;;) {
    if (text.startsWith('trailer', cursor)) {
      cursor += 'trailer'.length;
      break;
    }
    const sub = /^(\d+) (\d+)[\r\n]+/.exec(text.slice(cursor, cursor + 40));
    if (sub == null) {
      throw new Error('worksheet pdf canonicalize: malformed xref subsection header');
    }
    cursor += sub[0].length;
    const first = Number(sub[1]);
    const count = Number(sub[2]);
    for (let i = 0; i < count; i += 1) {
      const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(text.slice(cursor, cursor + 20));
      if (entry == null) {
        throw new Error(`worksheet pdf canonicalize: malformed xref entry for object ${first + i}`);
      }
      if (entry[3] === 'n') {
        objects.set(first + i, { offset: Number(entry[1]), gen: Number(entry[2]) });
      }
      cursor = skipLineEnd(text, cursor, `xref entry ${first + i}`);
    }
  }

  // --- trailer 字典（平衡 <<>> 扫描；trailer 无括串干扰） ---
  const dictStart = text.indexOf('<<', cursor);
  if (dictStart < 0) throw new Error('worksheet pdf canonicalize: trailer has no dictionary');
  let depth = 0;
  let dictEnd = -1;
  for (let i = dictStart; i < text.length - 1; i += 1) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth += 1;
      i += 1;
      continue;
    }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        dictEnd = i + 1; // 切片终点：'>>' 之后
        break;
      }
    }
  }
  if (dictEnd < 0) throw new Error('worksheet pdf canonicalize: unbalanced trailer dictionary');
  const trailerDict = text.slice(dictStart, dictEnd);
  if (/\/Prev\s+\d/.test(trailerDict)) {
    throw new Error('worksheet pdf canonicalize: incremental /Prev trailer chain unsupported');
  }

  const replacements: Array<{ at: number; length: number; text: string }> = [];
  const splice = (regionStart: number, regionEnd: number, rewrite: (s: string) => string) => {
    const region = text.slice(regionStart, regionEnd);
    const out = rewrite(region);
    if (out.length !== region.length) {
      throw new Error('worksheet pdf canonicalize: a rewrite changed byte length');
    }
    if (out !== region) replacements.push({ at: regionStart, length: region.length, text: out });
  };

  // (a) trailer /ID [<hex><hex>]：十六进制位同长度置 0。
  splice(dictStart, dictEnd, (region) =>
    region.replace(
      /\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/g,
      (_match, first: string, second: string) =>
        `/ID [<${'0'.repeat(first.length)}><${'0'.repeat(second.length)}>]`,
    ),
  );

  // (b) trailer /Info N 0 R → Info 对象（xref 偏移定位，endobj 截界）。
  const infoRef = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(trailerDict);
  if (infoRef != null) {
    const infoObj = Number(infoRef[1]);
    const infoGen = Number(infoRef[2]);
    const entry = objects.get(infoObj);
    if (entry == null) {
      throw new Error(`worksheet pdf canonicalize: /Info object ${infoObj} has no xref entry`);
    }
    if (!text.startsWith(`${infoObj} ${infoGen} obj`, entry.offset)) {
      throw new Error(
        `worksheet pdf canonicalize: xref offset for /Info ${infoObj} does not point at the object`,
      );
    }
    const objEnd = text.indexOf('endobj', entry.offset);
    if (objEnd < 0) {
      throw new Error('worksheet pdf canonicalize: /Info object has no endobj bound');
    }
    splice(entry.offset, objEnd, (region) =>
      region.replace(
        /\/(CreationDate|ModDate)\s*\(([^()]*)\)/g,
        (_match, key: string, value: string) => {
          const inner =
            value.length >= CANONICAL_PDF_DATE.length
              ? CANONICAL_PDF_DATE + ' '.repeat(value.length - CANONICAL_PDF_DATE.length)
              : ' '.repeat(value.length);
          return `/${key} (${inner})`;
        },
      ),
    );
  }

  // --- 应用替换（顺序无关，偏移不漂移——全部同长度） ---
  let out = text;
  for (const replacement of replacements.sort((a, b) => b.at - a.at)) {
    out =
      out.slice(0, replacement.at) +
      replacement.text +
      out.slice(replacement.at + replacement.length);
  }

  // --- 断言：长度不变 + xref 每个 n 条目仍指向 `N G obj` ---
  if (out.length !== text.length) {
    throw new Error('worksheet pdf canonicalize: output length drifted');
  }
  for (const [objNum, entry] of objects) {
    if (!out.startsWith(`${objNum} ${entry.gen} obj`, entry.offset)) {
      throw new Error(
        `worksheet pdf canonicalize: xref offset for object ${objNum} no longer points at it`,
      );
    }
  }
  return Buffer.from(out, 'latin1');
}

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
      // data:/blob:/about: 不出本进程 —— 站点图床（object URL）与内联资源走这里。
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
        return route.continue();
      }
      if (new URL(url).origin !== appOrigin) {
        abortedUrls.push(url);
        return route.abort('blockedbyclient');
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
          return route.abort('blockedbyclient');
        }
      }
      return route.fulfill({ response });
    });
    // WebSocket 不经 route() —— 单独拦：非本站一律关掉并记录。
    await context.routeWebSocket(
      () => true,
      (ws) => {
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
        ws.onMessage((message) => server.send(message));
        server.onMessage((message) => ws.send(message));
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
      throw new Error(
        `worksheet render: print page reported state=${outcome?.state ?? 'unreadable'}` +
          (outcome?.error ? ` error=${outcome.error}` : ''),
      );
    }

    const regionMap = (await page.evaluate(() => {
      const measure = (window as { __tlpWorksheetRegionMap?: () => unknown })
        .__tlpWorksheetRegionMap;
      if (measure == null) {
        throw new Error('window.__tlpWorksheetRegionMap is not defined on a ready page');
      }
      return measure();
    })) as WorksheetRegionMapDraft;

    const rawPdf = await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return { pdf: canonicalizeWorksheetPdf(rawPdf), regionMap, abortedUrls };
  } catch (error) {
    // 失败路径也带出被拦请求 —— 渲染失败时 result 不落 job.output，
    // 泄漏记录不能随 result 一起丢。
    const leaks = abortedUrls.length > 0 ? ` [aborted off-origin: ${abortedUrls.join(', ')}]` : '';
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
      throw new Error(`${error.message}${leaks}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onJobSignal);
    if (browser != null) await browser.close().catch(() => {});
  }
}

export interface WorksheetRenderResult {
  export_token: string;
  pdf_digest: string;
  blob_key: string;
  archive_status: 'archived' | 'existing';
  page_count: number;
  aborted_urls: string[];
}

export async function runWorksheetRender(
  db: Db,
  input: { export_token: string },
  deps: { appOrigin?: string; internalToken?: string; signal?: AbortSignal } = {},
): Promise<WorksheetRenderResult> {
  const appOrigin =
    deps.appOrigin ?? process.env.WORKSHEET_RENDER_APP_ORIGIN?.trim() ?? 'http://localhost:5173';
  if (appOrigin === '') {
    throw new Error('worksheet_render: WORKSHEET_RENDER_APP_ORIGIN is empty');
  }
  const internalToken = deps.internalToken ?? process.env.INTERNAL_TOKEN;
  if (!internalToken) {
    throw new Error(
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
    throw new Error(
      `worksheet render: measured region map fails the archive contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const body: WorksheetRegionMapArchiveBodyT = parsed.data;

  const blobKey = worksheetPdfBlobKey(pdfDigest);
  await putWorksheetExportPdf(pdfDigest, rendered.pdf);

  let out: ArchiveRegionMapResult;
  try {
    out = await archiveWorksheetRegionMap(db, input.export_token, body);
  } catch (error) {
    // write-once 冲突 / 并发抢存：存档事务已整体回滚（无半档），但 blob 已写。
    // content-addressed key ⇒ 同图重跑会原地覆盖，孤儿对象可判可清。
    throw new Error(
      `worksheet render: blob '${blobKey}' written but archive failed (orphaned blob, retry-safe): ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  switch (out.status) {
    case 'archived':
    case 'existing':
      return {
        export_token: input.export_token,
        pdf_digest: pdfDigest,
        blob_key: blobKey,
        archive_status: out.status,
        page_count: out.archive.page_count,
        aborted_urls: rendered.abortedUrls,
      };
    case 'not_found':
      throw new Error(`worksheet render: export '${input.export_token}' not found`);
    case 'invalid_map':
      throw new Error(
        `worksheet render: region map rejected by frozen-issuance validation: ${out.issues
          .map((issue) => `${issue.code}(${issue.detail})`)
          .join('; ')}`,
      );
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
