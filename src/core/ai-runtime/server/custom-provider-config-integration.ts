// YUK-1563 part 4 — custom provider 定义与模型目录的联动（AI owner 的配置接线）。
//
// 注册表与两个注入端口在 core/config/custom-providers；目录（catalog facts、
// 写后刷新、删除 prune）属于 AI owner。本模块只做装配：把 AI 侧注入的端口
// 投影成面板与写面要的 facts，并把 put/delete 事件接到同一刷新锁。core 不
// import server —— AI 侧实现在组合根绑定。

import {
  type CustomProviderCatalogFacts,
  type CustomProviderDefinition,
  type CustomProviderRefreshOutcome,
  customProviderDefinitions,
  setCustomProviderCatalogFactsSource,
  setCustomProviderChangeHandler,
} from '@/core/config/custom-providers';
import type { Db } from '@/db/client';

/**
 * AI owner 的目录视图，只含面板要读的两处事实：每个 catalog provider 的
 * check 与全局 findings。真实文档（CatalogMeta）结构上满足它。
 */
export interface CustomProviderCatalogView {
  readonly providerChecks: readonly {
    readonly provider: string;
    readonly providerOnly: readonly string[];
  }[];
  readonly findings: readonly { readonly catalogProvider: string }[];
}

/** AI 侧实现，由组合根绑定；配置 owner 不认识 model-catalog 模块。 */
export interface CustomProviderCatalogIntegrationPorts {
  readonly currentCatalog: () => CustomProviderCatalogView;
  readonly executableModelIds: (providerId: `custom:${string}`) => readonly string[];
  /** Panel auth verdict; unprobed when the catalog has no check for the provider. */
  readonly authLabelOf: (providerId: string) => string;
  readonly refreshCatalog: (db: Db) => Promise<CustomProviderRefreshOutcome>;
  /** Stored catalog version, or undefined when nothing is stored. */
  readonly pruneFromCatalog: (
    db: Db,
    providerId: `custom:${string}`,
  ) => Promise<string | undefined>;
}

/** 每个 custom provider 的面板事实（不含凭据材料）。 */
export function customProviderCatalogFacts(
  catalog: CustomProviderCatalogView,
  definitions: readonly CustomProviderDefinition[],
  ports: Pick<CustomProviderCatalogIntegrationPorts, 'executableModelIds' | 'authLabelOf'>,
): ReadonlyMap<string, CustomProviderCatalogFacts> {
  return new Map(
    definitions.map((definition) => {
      const check = catalog.providerChecks.find((entry) => entry.provider === definition.id);
      // The executable set, not the bucket ids: this is exactly what
      // createLoomPiModels().getModel (the save-time check) accepts.
      const runnable = ports.executableModelIds(definition.id);
      const unknown = check ? check.providerOnly.filter((id) => !runnable.includes(id)) : [];
      return [
        definition.id,
        {
          auth: ports.authLabelOf(definition.id),
          runnableModels: runnable,
          unknownModels: unknown,
          findings: catalog.findings.filter(
            (finding) => finding.catalogProvider === definition.id,
          ).length,
        },
      ];
    }),
  );
}

/**
 * Wire the catalog integration (API process): the panel facts source (fresh per
 * call from the live catalog) and the post-write change handler. A put runs the
 * shared catalog refresh: custom providers never get an auth probe of their own,
 * but a due built-in 1-token probe can ride the same refresh; a delete prunes
 * its bucket/check/findings under the refresh lock.
 */
export function registerCustomProviderCatalogIntegration(
  db: Db,
  ports: CustomProviderCatalogIntegrationPorts,
): void {
  setCustomProviderCatalogFactsSource(() =>
    customProviderCatalogFacts(ports.currentCatalog(), customProviderDefinitions(), ports),
  );
  setCustomProviderChangeHandler(async (event) => {
    if (event.kind === 'delete') {
      const version = await ports.pruneFromCatalog(db, event.id);
      return version
        ? { outcome: 'stored', version }
        : { outcome: 'kept', reason: 'nothing_stored', detail: 'no stored catalog document' };
    }
    return ports.refreshCatalog(db);
  });
}
