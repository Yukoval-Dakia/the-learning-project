import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withinAssessmentReviewExecutionClient } from './assessment-review-client';

// Actual installed driver, supplied only EventEmitter sockets: no PostgreSQL,
// listener, DNS, TCP or TLS connection is opened by these lifecycle invariants.
const { default: postgres } = await import('postgres');

function packet(kind: string, body: Buffer) {
  const bytes = Buffer.alloc(5 + body.length);
  bytes[0] = kind.charCodeAt(0);
  bytes.writeInt32BE(4 + body.length, 1);
  body.copy(bytes, 5);
  return bytes;
}

function offlineTransport() {
  const events: Array<{ pid: number; query: string; tx: boolean }> = [];
  const sockets: OfflineBackend[] = [];
  class OfflineBackend extends EventEmitter {
    readonly pid = 100 + sockets.length;
    locked = false;
    tx = false;
    closed = false;
    readyState = 'open';
    private started = false;
    constructor() {
      super();
      sockets.push(this);
    }
    private ready() {
      return packet('Z', Buffer.from(this.tx ? 'T' : 'I'));
    }
    write(bytes: Buffer, callback?: () => void) {
      if (!this.started) {
        this.started = true;
        const auth = Buffer.alloc(4);
        const key = Buffer.alloc(8);
        key.writeInt32BE(this.pid);
        key.writeInt32BE(1, 4);
        setImmediate(() =>
          this.emit('data', Buffer.concat([packet('R', auth), packet('K', key), this.ready()])),
        );
      } else {
        for (let offset = 0; offset < bytes.length; ) {
          const kind = String.fromCharCode(bytes[offset]);
          const length = bytes.readInt32BE(offset + 1);
          const body = bytes.subarray(offset + 5, offset + 1 + length);
          offset += 1 + length;
          if (kind === 'X') continue;
          expect(kind).toBe('Q');
          const query = body.toString().replace(/\0$/, '');
          events.push({ pid: this.pid, query, tx: this.tx });
          if (query.includes('pg_advisory_unlock')) this.locked = false;
          else if (query.includes('pg_try_advisory_lock')) this.locked = true;
          if (query === 'BEGIN') this.tx = true;
          if (query === 'ROLLBACK' || query === 'COMMIT') this.tx = false;
          setImmediate(() =>
            this.emit(
              'data',
              Buffer.concat([
                packet('T', Buffer.alloc(2)),
                packet('C', Buffer.from('SELECT 0\0')),
                this.ready(),
              ]),
            ),
          );
        }
      }
      callback?.();
      return true;
    }
    end() {
      this.destroy();
    }
    destroy() {
      this.closed = true;
      this.readyState = 'closed';
      this.locked = false;
      this.tx = false;
      setImmediate(() => this.emit('close', false));
    }
  }
  const options = {
    host: 'injected-db',
    port: 15432,
    database: 'injected-data',
    user: 'injected-user',
    password: () => 'fixture-password',
    max: 1,
    ssl: false,
    connect_timeout: 2,
    fetch_types: false,
    prepare: false,
    backoff: () => 0,
    idle_timeout: 0,
    max_lifetime: 0,
    socket: () => new OfflineBackend(),
  };
  return { source: postgres(options), sockets, events };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('assessment review dedicated execution client (offline installed driver)', () => {
  it('preserves injected target/auth/socket/options without sharing mutable driver state or reading replacement PG env', async () => {
    const f = offlineTransport();
    vi.stubEnv('PGHOST', 'wrong-global-host');
    vi.stubEnv('PGDATABASE', 'wrong-global-database');
    vi.stubEnv('PGPASSWORD', 'wrong-global-password');
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
      throw new Error('TCP forbidden in offline invariant');
    });
    try {
      await withinAssessmentReviewExecutionClient(f.source, async (client) => {
        expect(client).not.toBe(f.source);
        expect(client.options.host).toEqual(['injected-db']);
        expect(client.options.port).toEqual([15432]);
        expect(client.options.database).toBe('injected-data');
        expect(client.options.user).toBe('injected-user');
        expect(client.options.ssl).toBe(false);
        expect(client.options.connect_timeout).toBe(2);
        expect(client.options.max).toBe(1);
        expect(Reflect.get(client.options, 'socket')).toBe(Reflect.get(f.source.options, 'socket'));
        const password: unknown = Reflect.get(client.options, 'pass');
        if (typeof password !== 'function') throw new Error('Missing injected password callback');
        expect(await password()).toBe('fixture-password');
        expect(client.options.parsers).not.toBe(f.source.options.parsers);
        expect(client.options.serializers).not.toBe(f.source.options.serializers);
        expect(Reflect.get(client.options, 'shared')).not.toBe(
          Reflect.get(f.source.options, 'shared'),
        );
        expect(client.parameters).not.toBe(f.source.parameters);
        client.options.parsers[99999] = () => 'isolated-parser';
        expect(f.source.options.parsers[99999]).toBeUndefined();
        await client.unsafe('SELECT dedicated_target');
      });
      expect(connect).not.toHaveBeenCalled();
      expect(f.sockets.every((socket) => socket.closed)).toBe(true);
    } finally {
      await f.source.end({ timeout: 0 });
    }
  });

  it('stale unlock/release and whole-client close cannot hijack a successor client after owner loss', async () => {
    const f = offlineTransport();
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const successorEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const successorRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let successor: Promise<void> | undefined;
    let successorBackend: (typeof f.sockets)[number] | undefined;
    try {
      await f.source.unsafe('SELECT original_pool');
      await withinAssessmentReviewExecutionClient(f.source, async (oldClient) => {
        await oldClient.unsafe('SELECT old_owner');
        const old = await oldClient.reserve();
        await old.unsafe('SELECT pg_try_advisory_lock(1, 2)');
        const oldBackend = f.sockets.at(-1);
        if (!oldBackend) throw new Error('Missing old backend');
        oldBackend.destroy();
        await oldClient.unsafe('SELECT old_reconnect');
        successor = withinAssessmentReviewExecutionClient(f.source, async (client) => {
          await client.unsafe('SELECT successor');
          const reserved = await client.reserve();
          try {
            await reserved.unsafe('SELECT pg_try_advisory_lock(1, 2)');
            await reserved.unsafe('BEGIN');
            successorBackend = f.sockets.at(-1);
            entered();
            await successorRelease;
            await reserved.unsafe('SELECT successor_transaction');
            await reserved.unsafe('ROLLBACK');
          } finally {
            reserved.release();
          }
        });
        await successorEntered;
        // The old wrapper remains invalid even after its client slot reconnects.
        await expect(async () => old.unsafe('SELECT pg_advisory_unlock(1, 2)')).rejects.toThrow(
          'Assessment review execution connection was lost',
        );
        old.release();
        await oldClient.unsafe('SELECT old_released_slot');
      });
      expect(successorBackend?.locked).toBe(true);
      expect(successorBackend?.tx).toBe(true);
      expect(successorBackend?.closed).toBe(false);
      await f.source.unsafe('SELECT original_pool_after_old_close');
      expect(f.events.at(-1)?.tx).toBe(false);
      expect(f.events.at(-1)?.pid).not.toBe(successorBackend?.pid);
      expect(
        f.events.filter((event) => event.pid === successorBackend?.pid).map((event) => event.query),
      ).toEqual(['SELECT successor', 'SELECT pg_try_advisory_lock(1, 2)', 'BEGIN']);
      release();
      await successor;
      expect(f.events.find((event) => event.query === 'SELECT successor_transaction')?.tx).toBe(
        true,
      );
    } finally {
      release();
      await successor;
      await f.source.end({ timeout: 0 });
    }
  });

  it('rejects stale witness and cleanup queries after close without reconnecting or writing to a null socket', async () => {
    const f = offlineTransport();
    try {
      await f.source.unsafe('SELECT original_pool');
      await withinAssessmentReviewExecutionClient(f.source, async (client) => {
        await client.unsafe('SELECT execution_owner');
        const reserved = await client.reserve();
        await reserved.unsafe('SELECT pg_try_advisory_lock(1, 2)');
        Object.defineProperty(reserved, 'begin', {
          value: async () => reserved.unsafe('BEGIN'),
        });
        await reserved.begin(async () => {});
        await reserved.unsafe('ROLLBACK');
        const backend = f.sockets.at(-1);
        if (!backend) throw new Error('Missing execution backend');
        const closed = once(backend, 'close');
        backend.destroy();
        await closed;
        const socketsBefore = f.sockets.length;
        const queriesBefore = f.events.length;
        for (const query of ['SELECT pg_backend_pid()', 'SELECT pg_advisory_unlock(1, 2)'])
          await expect(async () => reserved.unsafe(query)).rejects.toThrow(
            'Assessment review execution connection was lost',
          );
        await expect(async () => reserved`SELECT pg_backend_pid()`).rejects.toThrow(
          'Assessment review execution connection was lost',
        );
        await expect(async () => reserved.begin(async () => {})).rejects.toThrow(
          'Assessment review execution connection was lost',
        );
        reserved.release();
        await expect(client.reserve()).rejects.toThrow(
          'Assessment review execution connection was lost',
        );
        expect(f.sockets).toHaveLength(socketsBefore);
        expect(f.events).toHaveLength(queriesBefore);
      });
      await f.source.unsafe('SELECT original_pool_after_loss');
      expect(f.events.at(-1)?.pid).toBe(f.sockets[0].pid);
      expect(f.sockets.slice(1).every((socket) => socket.closed)).toBe(true);
    } finally {
      await f.source.end({ timeout: 0 });
    }
  });

  it('closes a failed execution without closing or releasing the original pool', async () => {
    const f = offlineTransport();
    const failure = new Error('domain failure');
    try {
      await f.source.unsafe('SELECT original_pool');
      await expect(
        withinAssessmentReviewExecutionClient(f.source, async (client) => {
          await client.unsafe('SELECT failing_execution');
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(f.sockets[1].closed).toBe(true);
      expect(f.sockets[0].closed).toBe(false);
      await f.source.unsafe('SELECT original_pool_still_usable');
      expect(f.events.at(-1)?.pid).toBe(f.sockets[0].pid);
    } finally {
      await f.source.end({ timeout: 0 });
    }
  });

  it('preserves domain and close failures after attempting whole-client disposal', async () => {
    const f = offlineTransport();
    const domainFailure = new Error('domain failure');
    const closeFailure = new Error('close failure');
    try {
      const result = withinAssessmentReviewExecutionClient(f.source, async (client) => {
        await client.unsafe('SELECT failing_execution');
        const end = client.end.bind(client);
        vi.spyOn(client, 'end').mockImplementation(async (options) => {
          await end(options);
          throw closeFailure;
        });
        throw domainFailure;
      });
      await expect(result).rejects.toMatchObject({
        errors: [domainFailure, closeFailure],
        cause: domainFailure,
      });
      expect(f.sockets.every((socket) => socket.closed)).toBe(true);
      await f.source.unsafe('SELECT original_pool_still_usable');
    } finally {
      await f.source.end({ timeout: 0 });
    }
  });
});
