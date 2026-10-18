// YUK-1529 — worksheet_render job：服务端无头 Chromium 渲染作答卷。
//
// 流程（与 UI 线验证过的渲染配方逐字一致）：
//   1. playwright-core 开 /print/worksheet/<token>（Asia/Tokyo context，
//      emulateMedia print 在导航之前 —— 不设 print media 隐藏测量区没有
//      布局，量出的区域图是错的）；
//   2. 等 <html data-worksheet-state="ready">；error/layout_overflow 如实失败；
//   3. 同一页面调 window.__tlpWorksheetRegionMap() 拿区域图；
//   4. 同一页面 page.pdf()；
//   5. canonicalize（抹掉 Chromium 每次渲染都打上的墙钟元数据）→ sha256 →
//      pdf_digest；
//   6. PDF 写 R2（content-addressed key，重跑安全）；
//   7. 走 #1773 既有 archiveWorksheetRegionMap write-once 存档：
//      同图同 digest ⇒ existing，异 ⇒ 冲突如实抛出。
//
// 网络锁死：context.route('**/*') 只允许 app 自身 origin 的请求；data:/blob:/
// about: 不是网络请求照常放行；其余一律 abort 并进 job 结果的
// aborted_urls —— 泄漏可见。
//
// 不存半档：任何一步失败都不存档；blob 已写但存档失败时错误信息带留下的
// content-addressed key。
//
// 本 job 不调任何模型，零成本。Chromium 只在 worker 镜像（Dockerfile worker
// stage），app 镜像不变。

import { createHash } from 'node:crypto';
import type { Job } from 'pg-boss';
import { type Page, chromium } from 'playwright-core';

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

const NAV_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 120_000;

/**
 * Chromium（Skia/PDF）每次渲染都嵌入墙钟 CreationDate/ModDate 与随机 trailer
 * /ID —— 同一份 DOM 出两份不同字节，write-once 存档会把重跑误判成冲突。
 * 把这些字段同长度抹掉（xref 偏移不变，PDF 仍合法），产物变成内容寻址：
 * 相同卷面 ⇒ 相同字节 ⇒ 相同 pdf_digest ⇒ 重跑 existing。
 */
export function canonicalizeWorksheetPdf(pdf: Buffer): Buffer {
  let text = pdf.toString('latin1');
  text = text.replace(
    /\/(CreationDate|ModDate|Producer|Creator|Title|Author|Subject|Keywords)\s*\(([^()]*)\)/g,
    (_match, key: string, value: string) => `/${key} (${' '.repeat(value.length)})`,
  );
  text = text.replace(
    /\/ID\s*\[\s*<([0-9a-fA-F]*)>\s*<([0-9a-fA-F]*)>\s*\]/g,
    (_match, first: string, second: string) =>
      `/ID [<${'0'.repeat(first.length)}><${'0'.repeat(second.length)}>]`,
  );
  return Buffer.from(text, 'latin1');
}

/** window.__tlpWorksheetRegionMap() 的返回形状（ui/worksheet-measure.ts 的
 * WorksheetRegionMapDraft —— 存档体减 pdf_digest）。 */
export type WorksheetRegionMapDraft = Omit<WorksheetRegionMapArchiveBodyT, 'pdf_digest'>;

export interface WorksheetPageRender {
  /** canonicalize 后的 PDF 字节（写入 R2、digest 的对象）。 */
  pdf: Buffer;
  /** 页面内量出的区域图（WorksheetRegionMapArchiveBody 减 pdf_digest）。 */
  regionMap: WorksheetRegionMapDraft;
  /** 被网络锁死 abort 的非本站 URL（job 结果带出，泄漏可见）。 */
  abortedUrls: string[];
}

async function readPageState(
  page: Page,
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

/** 渲染一份作答卷：开打印页 → 等就绪 → 量区域图 → page.pdf()。 */
export async function renderWorksheetPage(input: {
  appOrigin: string;
  exportToken: string;
  internalToken: string;
}): Promise<WorksheetPageRender> {
  const appOrigin = new URL(input.appOrigin).origin;
  const abortedUrls: string[] = [];

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      // data:/blob:/about: 不出本进程 —— 站点图床（object URL）与内联资源走这里。
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) {
        return route.continue();
      }
      if (new URL(url).origin === appOrigin) return route.continue();
      abortedUrls.push(url);
      return route.abort('blockedbyclient');
    });
    // 打印页 apiFetch 从 localStorage 读 internal token（src/ui/lib/api.ts）；
    // 在 app JS 运行前种下。
    await context.addInitScript(
      (args: { key: string; token: string }) => {
        window.localStorage.setItem(args.key, args.token);
      },
      { key: TOKEN_STORAGE_KEY, token: input.internalToken },
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
  } finally {
    await browser.close();
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
  deps: { appOrigin?: string; internalToken?: string } = {},
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

  const rendered = await renderWorksheetPage({
    appOrigin,
    exportToken: input.export_token,
    internalToken,
  });

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
      const result = await runWorksheetRender(db, { export_token: data.export_token });
      console.log('[worksheet_render]', JSON.stringify(result));
      // batchSize=1：返回值落 job.output（kernel JobHandlerFactory docblock）。
      return result;
    }
    return null;
  };
}
