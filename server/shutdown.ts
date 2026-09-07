/** The API owns transport drain; disconnecting a stream is not a durable run Stop. */
export function installApiShutdown(
  server: {
    close(callback: (error?: Error) => void): unknown;
    closeAllConnections?: () => void;
  },
  closeRuntime: () => Promise<void>,
): () => void {
  let stopping = false;
  const handler = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`[rw:api] ${signal} received, draining HTTP and runtime`);
    // HTTP gets 30s, then boss retains its own 30s, with 5s for pool cleanup.
    // Keep this timer referenced: a stalled cleanup must not silently exit 0.
    const deadline = setTimeout(() => {
      console.error('[rw:api] shutdown deadline exceeded');
      process.exit(1);
    }, 65_000);
    let transportDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        transportDeadline = setTimeout(() => {
          console.warn('[rw:api] HTTP drain timeout; disconnecting remaining transports');
          server.closeAllConnections?.();
        }, 30_000);
        server.close((error) => (error ? reject(error) : resolve()));
      });
      clearTimeout(transportDeadline);
      await closeRuntime();
      console.log('[rw:api] stopped cleanly');
      process.exit(0);
    } catch (error) {
      console.error('[rw:api] shutdown failed', error);
      process.exit(1);
    } finally {
      clearTimeout(transportDeadline);
      clearTimeout(deadline);
    }
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
