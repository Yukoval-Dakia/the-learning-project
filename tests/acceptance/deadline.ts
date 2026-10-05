/** Await actual lifecycle settlement even after the acceptance deadline. */
export async function settleWithAcceptanceDeadline<T>(
  execute: () => Promise<T>,
  stop: () => Promise<void>,
  timeoutMs: number,
): Promise<T> {
  let stopping: Promise<void> | undefined;
  let timedOut = false;
  let stopError: unknown;
  const timer = setTimeout(() => {
    timedOut = true;
    stopping = Promise.resolve()
      .then(stop)
      .catch((error) => {
        stopError = error;
      });
  }, timeoutMs);
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await execute() };
  } catch (error) {
    outcome = { error };
  } finally {
    clearTimeout(timer);
    await stopping;
  }
  if (timedOut)
    throw new Error('acceptance deadline exceeded after lifecycle settlement', {
      cause: stopError ?? ('error' in outcome ? outcome.error : undefined),
    });
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
