// YUK-1563 part 4 — custom provider registry 的 DB 水合、跨进程 watch 与目录联动
// （server 组合根侧）。core/config/custom-providers 持纯注册表与注入端口；本模块
// 是 server 进程的 IO 面（core/config/store ↔ server/config/hydrate 同构）。目录
// 联动在 server/index.ts boot 时接线：定义写入后触发一次无付费探针的目录刷新，
// 删除时在刷新锁内清 bucket/check/finding。

import {
  type CustomProviderChangeEvent,
  type CustomProviderRecord,
  type CustomProviderRefreshOutcome,
  customProviderDefinitions,
  customProviderRecordFromRow,
  installCustomProviders,
  registryStampOf,
  setCustomProviderCatalogFactsSource,
  setCustomProviderChangeHandler,
} from '@/core/config/custom-providers';
import { type Db, db as defaultDb } from '@/db/client';
import { custom_provider } from '@/db/schema';
import { catalogModelIds, currentModelCatalog } from '@/server/ai/model-catalog';
import { providerAuthLabel } from '@/server/ai/provider-models-check';

const SELECTION = {
  id: custom_provider.id,
  display_name: custom_provider.display_name,
  base_url: custom_provider.base_url,
  api_key_env: custom_provider.api_key_env,
  protocol: custom_provider.protocol,
  created_at: custom_provider.created_at,
  updated_at: custom_provider.updated_at,
} as const;

export async function selectCustomProviderRecords(
  db: Db = defaultDb,
): Promise<readonly CustomProviderRecord[]> {
  const rows = await db.select(SELECTION).from(custom_provider);
  return rows
    .map(customProviderRecordFromRow)
    .sort((left, right) => left.id.localeCompare(right.id));
}

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

/**
 * Wire the server-side catalog integration (API process): the panel facts
 * source (fresh per call from the live catalog) and the post-write change
 * handler (unbilled /models refresh on put, locked bucket prune on delete).
 */
export function registerCustomProviderCatalogIntegration(db: Db = defaultDb): void {
  setCustomProviderCatalogFactsSource(() => {
    const catalog = currentModelCatalog();
    return new Map(
      customProviderDefinitions().map((definition) => {
        const check = catalog.providerChecks.find((entry) => entry.provider === definition.id);
        const runnable = catalogModelIds(definition.id);
        const unknown = check ? check.providerOnly.filter((id) => !runnable.includes(id)) : [];
        return [
          definition.id,
          {
            auth: check ? providerAuthLabel(check) : 'unprobed',
            runnableModels: runnable,
            unknownModels: unknown,
            findings: catalog.findings.filter(
              (finding) => finding.catalogProvider === definition.id,
            ).length,
          },
        ];
      }),
    );
  });
  setCustomProviderChangeHandler(
    async (event: CustomProviderChangeEvent): Promise<CustomProviderRefreshOutcome> => {
      const { refreshModelCatalog, pruneCustomProviderFromCatalog } = await import(
        '@/server/ai/model-catalog'
      );
      if (event.kind === 'delete') {
        const version = await pruneCustomProviderFromCatalog(db, event.id);
        return version
          ? { outcome: 'stored', version }
          : { outcome: 'kept', reason: 'nothing_stored', detail: 'no stored catalog document' };
      }
      const refreshed = await refreshModelCatalog(db);
      return refreshed.outcome === 'stored'
        ? { outcome: 'stored', version: refreshed.meta.version }
        : { outcome: 'kept', reason: refreshed.reason, detail: refreshed.detail };
    },
  );
}
