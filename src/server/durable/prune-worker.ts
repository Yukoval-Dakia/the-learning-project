import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { MountedDurableFamily } from '@/kernel/manifest';
import {
  type AdmittedFamily,
  type FamilyBoundaries,
  mountDurableFamilies,
} from './family-contract';
import { PRUNE_DBOS_SCHEMA } from './prune-family';

/**
 * The generic durable-family host. It mounts every admitted family through its
 * own adapter (`AdmittedFamily.adapter.mount`), launches DBOS once, and runs a
 * single reconcile/stop loop over the mounted handles. It holds no family or
 * member name — families contribute themselves through the manifest
 * `durable.load` contract.
 */
export type DurableWorkerOptions = {
  boss: PgBoss;
  db: Db;
  families: readonly AdmittedFamily[];
  boundaries?: FamilyBoundaries;
  reconcileIntervalMs?: number;
};

type Host = {
  boss: PgBoss;
  db: Db;
  key: string;
  promise: Promise<MountedDurableFamily[]>;
  shutdown?: () => Promise<void>;
  stopPromise?: Promise<number>;
};
let registration: Host | undefined;

function declarationKey(families: readonly AdmittedFamily[]) {
  // Freeze the admitted surface; a changed family set or contract fails
  // explicitly rather than silently remounting a different host.
  return JSON.stringify(
    families.map(({ adapter, decls }) => [
      adapter.label,
      Object.values(decls).map((decl) => ({
        name: decl.name,
        schedule: decl.schedule ? { cron: decl.schedule.cron, tz: decl.schedule.tz } : null,
      })),
    ]),
  );
}

export async function stopDurableWorker(): Promise<number> {
  const host = registration;
  if (!host) return 0;
  if (!host.stopPromise)
    host.stopPromise = (async () => {
      const started = performance.now();
      try {
        await host.promise.catch(() => {});
        await host.shutdown?.();
      } finally {
        if (registration === host) registration = undefined;
      }
      return Math.ceil(performance.now() - started);
    })();
  return host.stopPromise;
}

function startHost(options: DurableWorkerOptions) {
  const key = declarationKey(options.families);
  if (registration) {
    if (
      registration.boss !== options.boss ||
      registration.db !== options.db ||
      registration.key !== key ||
      registration.stopPromise
    )
      throw new Error(
        'DBOS host cannot change boss, database or admitted declarations after startup',
      );
    return registration.promise;
  }
  const host: Host = {
    boss: options.boss,
    db: options.db,
    key,
    promise: Promise.resolve().then(() => mountHost(options, host)),
  };
  registration = host;
  host.promise = host.promise.catch((error: unknown) => {
    if (registration === host) registration = undefined;
    throw error;
  });
  return host.promise;
}

/** Mount admitted families; each adapter returns its own reconcile/stop handle. */
export async function startDurableWorker(
  options: DurableWorkerOptions,
): Promise<MountedDurableFamily[]> {
  return startHost(options);
}

async function mountHost(
  { boss, db, families, boundaries = {}, reconcileIntervalMs = 15000 }: DurableWorkerOptions,
  host: Host,
): Promise<MountedDurableFamily[]> {
  const mounted = await mountDurableFamilies({ boss, db, families, boundaries });
  DBOS.setConfig({
    name: 'tlp-housekeeping',
    systemDatabaseUrl: process.env.DATABASE_URL,
    systemDatabaseSchemaName: PRUNE_DBOS_SCHEMA,
    executorID: 'local',
    applicationVersion: 'prune-v1',
    systemDatabasePoolSize: 3,
    enableOTLP: false,
    tracingEnabled: false,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let pending = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;
  host.shutdown = () => {
    if (!shutdownPromise)
      shutdownPromise = (async () => {
        stopping = true;
        clearInterval(timer);
        await pending;
        const errors: unknown[] = [];
        for (const backend of mounted) {
          try {
            await backend.stop();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await DBOS.shutdown({ workflowCompletionTimeoutMS: 3000 });
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) throw new AggregateError(errors, 'Durable shutdown failed');
      })();
    return shutdownPromise;
  };
  try {
    await DBOS.launch();
    const reconcileAll = async () => {
      if (stopping) return;
      const errors: unknown[] = [];
      // One family failing must not starve the other families on this tick.
      for (const backend of mounted) {
        try {
          await backend.reconcile();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Durable backend reconciliation failed');
    };
    await reconcileAll();
    timer = setInterval(() => {
      pending = pending.then(reconcileAll).catch((error: unknown) => {
        console.error('[durable-worker] backend reconciliation failed', error);
      });
    }, reconcileIntervalMs);
    timer.unref();
    return mounted;
  } catch (error) {
    try {
      await host.shutdown();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Durable startup and cleanup failed');
    }
    throw error;
  }
}
