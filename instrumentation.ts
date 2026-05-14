/**
 * Next.js instrumentation hook (https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation)
 *
 * 启动时调一次 startListenLoop() —— app process（不是 worker process）才需要。
 * worker process 由 `scripts/worker.ts` 直接调启动。
 *
 * 见 Sub 0c plan Step 4.3 / Step 14。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startListenLoop } = await import('@/server/events/listen_loop');
    await startListenLoop();
    console.log('[instrumentation] LISTEN loop started');
  }
}
