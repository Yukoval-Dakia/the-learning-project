// YUK-1528 — waits until a rendered subtree is final: fonts loaded, KaTeX typeset, every image
// fetched and decoded, and the layout given a couple of frames to settle. Called from ref
// callbacks (commit phase), never during render.

import { preloadMathPlugins } from '@/ui/lib/math-markdown';

export type SettleFailure = 'asset_failed';

export class WorksheetSettleError extends Error {
  constructor(readonly code: SettleFailure) {
    super(code);
  }
}

const ASSET_TIMEOUT_MS = 30_000;

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

async function waitForImages(root: Element, isCancelled: () => boolean): Promise<void> {
  const started = performance.now();
  for (;;) {
    if (isCancelled()) return;
    if (root.querySelector('[data-asset-error]')) throw new WorksheetSettleError('asset_failed');
    const images = [...root.querySelectorAll('img')];
    const pending =
      root.querySelector('[data-asset-pending], img[aria-busy="true"]') != null ||
      images.some((image) => !image.getAttribute('src'));
    if (!pending) {
      try {
        await Promise.all(images.map((image) => image.decode()));
      } catch {
        throw new WorksheetSettleError('asset_failed');
      }
      return;
    }
    if (performance.now() - started > ASSET_TIMEOUT_MS) {
      throw new WorksheetSettleError('asset_failed');
    }
    await nextFrames(2);
  }
}

/**
 * Resolve when `root` is visually final. Rejects with WorksheetSettleError('asset_failed') when an
 * image cannot be loaded or decoded.
 */
export async function settleSubtree(
  root: Element,
  options: { math: boolean; isCancelled: () => boolean },
): Promise<void> {
  await document.fonts.ready;
  if (options.math) await preloadMathPlugins();
  // Let React commit the KaTeX re-render and asset URLs start resolving.
  await nextFrames(2);
  await waitForImages(root, options.isCancelled);
  // KaTeX and late text request their fonts only once laid out.
  await document.fonts.ready;
  await nextFrames(2);
}
