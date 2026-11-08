// YUK-1869 — 管理面配置读面的事实装配（配置 owner）。
//
// 事实来源（provider 目录/认证投影、任务 catalog、cron 声明、运行常量、
// consumer-effective 值）属于各自 owner；组合根经 AdminConfigFactsPorts 注入，
// 本模块只决定读面事实的最终形状与派生规则（global_pin、task_bindings），
// 不认识任何 provider/catalog 实现。行为与原组合根实现一致：每请求重算。

import type { AdminConfigFactsPorts, AdminConfigRuntimeFacts } from '../contracts/admin';

/**
 * Assemble the runtime fact bundle for one request. `global_pin` derives from the
 * effective values the same way the read face reads it: a string provider is
 * live, model is carried only when it is a string (model-only config is inert).
 */
export function buildAdminConfigRuntimeFacts(
  ports: AdminConfigFactsPorts,
): AdminConfigRuntimeFacts {
  const effectiveValues = ports.effectiveValues;
  const globalProvider = effectiveValues['lane.global.provider']?.value;
  const globalModel = effectiveValues['lane.global.model']?.value;
  return {
    global_pin:
      typeof globalProvider === 'string'
        ? {
            provider: globalProvider,
            ...(typeof globalModel === 'string' ? { model: globalModel } : {}),
          }
        : null,
    global: ports.resolveGlobalEffective(process.env),
    task_bindings: Object.fromEntries(
      ports.taskCatalog.map((task) => [task.kind, ports.resolveTaskEffective(task.kind)]),
    ),
    task_catalog: ports.taskCatalog,
    providers: ports.providers,
    manifest_schedules: ports.manifestSchedules,
    infra_schedules: ports.infraSchedules,
    runtime: ports.runtime,
    effective_values: effectiveValues,
  };
}
