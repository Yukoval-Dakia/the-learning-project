/** SSE comments do not prove generation progress. Observe bytes without
 * buffering events: a long data line must keep a legitimate slow stream alive. */
export function watchProviderStream(
  response: Response,
  idleMs: number,
  fail: (error: Error) => void,
): Response {
  if (
    !idleMs ||
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout>;
  let ended = false;
  let prefix = '';
  let inData = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (ended) return;
          ended = true;
          const error = new Error(
            `provider_stream_idle: no SSE data bytes for ${idleMs}ms; request outcome/charge may be unknown; automatic resend forbidden`,
          );
          fail(error);
          controller.error(error);
          void reader.cancel(error).catch(() => {});
        }, idleMs);
      };
      arm();
      // Pump independently of consumer demand so SDK buffering cannot turn
      // keep-alives into progress or leave the socket alive after termination.
      void (async () => {
        try {
          while (!ended) {
            const next = await reader.read();
            if (ended) return;
            if (next.done) {
              ended = true;
              clearTimeout(timer);
              controller.close();
              return;
            }
            let progress = false;
            for (const byte of next.value) {
              if (byte === 10 || byte === 13) {
                prefix = '';
                inData = false;
              } else if (inData) {
                if (byte !== 32 && byte !== 9) progress = true;
              } else if (prefix.length < 5) {
                prefix += String.fromCharCode(byte);
                if (prefix === 'data:') inData = true;
              }
            }
            if (progress) arm();
            controller.enqueue(next.value);
          }
        } catch (error) {
          if (!ended) {
            ended = true;
            clearTimeout(timer);
            controller.error(error);
          }
        } finally {
          reader.releaseLock();
        }
      })();
    },
    cancel(reason) {
      ended = true;
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
