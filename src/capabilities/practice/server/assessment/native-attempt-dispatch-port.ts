import type { dispatchNativeAttempt } from './durable-attempt';

type Dispatch = typeof dispatchNativeAttempt;
export type NativeAttemptDispatchOptions = Parameters<Dispatch>[3];

/**
 * YUK-1355 owns queue choice and recovery. The business operation calls this
 * once after admission. A null result selects synchronous formal commit; a run
 * id means the durable intent already exists, even if delivery needs recovery.
 */
export type NativeAttemptDispatchPort = (
  database: Parameters<Dispatch>[0],
  questionId: Parameters<Dispatch>[1],
  request: Parameters<Dispatch>[2],
  options: NativeAttemptDispatchOptions,
) => ReturnType<Dispatch>;
