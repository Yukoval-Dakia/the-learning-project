import postgres from 'postgres';
import type { Db } from '@/db/client';

/** No other execution may reserve a connection from this client's queues. */
export async function withinAssessmentReviewExecutionClient<T>(
  source: Pick<Db['$client'], 'options'>,
  work: (client: Db['$client']) => Promise<T>,
): Promise<T> {
  const options = source.options;
  // ParsedOptions types pass as null, although the installed driver preserves
  // the supplied string/password callback. Validate that runtime boundary.
  const password: unknown = Reflect.get(options, 'pass');
  if (typeof password !== 'string' && typeof password !== 'function')
    throw new TypeError('Unsupported assessment review database authentication');
  const pass =
    typeof password === 'string'
      ? password
      : async () => {
          const value: unknown = await password.call(options);
          if (typeof value !== 'string')
            throw new TypeError('Database password callback did not return a string');
          return value;
        };
  const shared: unknown = Reflect.get(options, 'shared');
  const typeArrayMap =
    shared &&
    typeof shared === 'object' &&
    'typeArrayMap' in shared &&
    shared.typeArrayMap &&
    typeof shared.typeArrayMap === 'object'
      ? { ...shared.typeArrayMap }
      : {};
  // The driver recognizes its resolved options by shared. Preserve the injected
  // target, socket, TLS and callbacks without consulting process-wide PG env,
  // while giving this client independent mutable type/parameter/retry state.
  const isolatedOptions = {
    ...options,
    host: [...options.host],
    port: [...options.port],
    connection: { ...options.connection },
    types: { ...options.types },
    parsers: { ...options.parsers },
    serializers: { ...options.serializers },
    shared: { retries: 0, typeArrayMap },
    parameters: {},
    pass,
    max: 1,
  };
  // postgres 3.4.9 accepts these resolved options through its shared fast path;
  // its public constructor types only describe unresolved scalar host/port.
  const transportOptions = isolatedOptions as unknown as postgres.Options<
    Record<string, postgres.PostgresType>
  >;
  const client = postgres(transportOptions);
  type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
  const outcome = await Promise.resolve()
    .then(() => work(client))
    .then(
      (value): Outcome => ({ ok: true, value }),
      (error: unknown): Outcome => ({ ok: false, error }),
    );
  try {
    // This whole client belongs to one execution, including a replacement
    // backend reached by its stale wrapper after a disconnect.
    await client.end({ timeout: 0 });
  } catch (closeError) {
    if (!outcome.ok)
      throw new AggregateError(
        [outcome.error, closeError],
        'Assessment review work and client cleanup failed',
        { cause: outcome.error },
      );
    throw closeError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
