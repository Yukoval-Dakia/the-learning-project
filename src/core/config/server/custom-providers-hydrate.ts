// YUK-1563 part 4 — custom provider registry 的 DB 水合与跨进程 watch（配置
// owner 的 server adapter）。core/config/custom-providers 持纯注册表与注入端口；
// 本模块是进程的 IO 面（core/config/store ↔ core/config/server/hydrate 同构）。
// 目录联动（catalog facts + 写后刷新）归 AI owner，经
// core/ai-runtime/server/custom-provider-config-integration.ts 注入。

import {
  type CustomProviderRecord,
  installCustomProviders,
  registryStampOf,
} from '@/core/config/custom-providers';
import { type Db, db as defaultDb } from '@/db/client';
import { selectCustomProviderRecords } from './custom-providers-read';

let lastInstalled: readonly CustomProviderRecord[] = [];

function install(records: readonly CustomProviderRecord[]): void {
  lastInstalled = [...records];
  installCustomProviders(records);
}

/** Boot read + registry install. Missing table (pre-migration) keeps the empty registry. */
export async function hydrateCustomProviders(
  db: Db = defaultDb,
): Promise<readonly CustomProviderRecord[]> {
  try {
    const records = await selectCustomProviderRecords(db);
    install(records);
    return records;
  } catch (error) {
    console.warn(
      '[custom-providers] hydration failed — registry stays empty',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export const CUSTOM_PROVIDERS_WATCH_INTERVAL_MS = 60_000;

/** Reload when another process wrote the table; the writing process is already current. */
export function startCustomProvidersWatch(
  db: Db = defaultDb,
  intervalMs = CUSTOM_PROVIDERS_WATCH_INTERVAL_MS,
): { stop: () => void } {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const records = await selectCustomProviderRecords(db);
        if (registryStampOf(records) === registryStampOf(lastInstalled)) return;
        install(records);
        console.info(`[custom-providers] registry reloaded providers=${records.length}`);
      } catch {
        // Pre-migration database or transient failure: keep the current registry.
      }
    })();
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
