// YUK-1869 — AI 侧实现配置 owner 的 custom provider 目录端口。
//
// 配置 owner（core/ai-runtime/server/custom-provider-config-integration）只认识
// 结构化的目录视图；目录文档、可执行模型集与面板 auth 标签都是 AI 事实，在
// 这里绑定真实实现，组合根 boot 时传入。读只投影事实，不发请求。

import type { CustomProviderCatalogIntegrationPorts } from '@/core/ai-runtime/server/custom-provider-config-integration';
import {
  currentModelCatalog,
  pruneCustomProviderFromCatalog,
  refreshModelCatalog,
} from './model-catalog';
import { executablePiModelIds } from './pi-models';
import { providerAuthLabel } from './provider-models-check';

export function customProviderCatalogIntegrationPorts(): CustomProviderCatalogIntegrationPorts {
  return {
    currentCatalog: currentModelCatalog,
    executableModelIds: executablePiModelIds,
    authLabelOf: (providerId) => {
      const check = currentModelCatalog().providerChecks.find(
        (entry) => entry.provider === providerId,
      );
      return check ? providerAuthLabel(check) : 'unprobed';
    },
    refreshCatalog: async (db) => {
      const refreshed = await refreshModelCatalog(db);
      return refreshed.outcome === 'stored'
        ? { outcome: 'stored', version: refreshed.meta.version }
        : { outcome: 'kept', reason: refreshed.reason, detail: refreshed.detail };
    },
    pruneFromCatalog: pruneCustomProviderFromCatalog,
  };
}
