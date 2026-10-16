// Whether this device should draw the mascot in 3D or show the still flower (B4).
//
// The glass flower is expensive: under software WebGL the loft prototype froze compositing for
// 10–16 s and its first initialisation for about 3 s (scorecard §4.3). So it only renders in 3D on
// a hardware-accelerated context, with motion allowed, on a device that is not obviously weak.
// The low-power thresholds are provisional; YUK-1395 owns the final ones.
import { prefersReducedMotion } from '../motion/reduced-motion';

export type MascotRender = 'gl' | 'still';

export type StillReason =
  | 'reduced-motion'
  | 'no-webgl'
  | 'software-renderer'
  | 'low-power'
  | 'context-lost'
  | 'shader-failed'
  | 'load-failed';

export interface MascotSupport {
  render: MascotRender;
  reason?: StillReason;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i;

interface NavigatorHints {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

function lowPower(): boolean {
  const nav = navigator as Navigator & NavigatorHints;
  if (nav.connection?.saveData) return true;
  if (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 2) return true;
  // Chromium only; absent elsewhere.
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) return true;
  return false;
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

function context(canvas: HTMLCanvasElement, caveat: boolean): GL | null {
  const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: caveat };
  try {
    return (canvas.getContext('webgl2', attrs) ?? canvas.getContext('webgl', attrs)) as GL | null;
  } catch {
    return null;
  }
}

function release(gl: GL | null) {
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
}

let probed: MascotSupport | null = null;

/** The GPU half of the decision, probed once per page load (it creates a throwaway context). */
function probeGpu(): MascotSupport {
  if (probed) return probed;
  const canvas = document.createElement('canvas');
  const fast = context(canvas, true);
  if (!fast) {
    // A context that only exists without the performance-caveat flag is a software one.
    const slow = context(document.createElement('canvas'), false);
    probed = { render: 'still', reason: slow ? 'software-renderer' : 'no-webgl' };
    release(slow);
    return probed;
  }
  const info = fast.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? String(fast.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  release(fast);
  probed = SOFTWARE.test(renderer)
    ? { render: 'still', reason: 'software-renderer' }
    : { render: 'gl' };
  return probed;
}

/**
 * Decide how to draw the mascot right now. Reduced motion and power hints are read live; the GPU
 * probe is cached. Call it at idle time, never in the frame of an interaction.
 */
export function mascotSupport(): MascotSupport {
  if (typeof window === 'undefined') return { render: 'still', reason: 'no-webgl' };
  if (prefersReducedMotion()) return { render: 'still', reason: 'reduced-motion' };
  if (lowPower()) return { render: 'still', reason: 'low-power' };
  return probeGpu();
}
