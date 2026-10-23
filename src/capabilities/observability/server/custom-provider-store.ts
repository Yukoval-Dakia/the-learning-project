// YUK-1563 part 4 — 自定义 provider CRUD 的 observability 写面（admin config 家族）。
// DB 直写走 @/db 迁移期豁免（agency goal-create 先例）；定义校验与注册表在
// @/core/config/custom-providers；写后经 core 端口触发 server 侧目录联动
// （无付费探针）。凭据只收 env 变量名，值不进库不进日志。

import { eq } from 'drizzle-orm';
import {
  CUSTOM_PROVIDER_LIMIT,
  type CustomProviderDefinition,
  type CustomProviderRecord,
  type CustomProviderRefreshOutcome,
  customProviderIdFor,
  customProviderRecordFromRow,
  getCustomProviderCatalogFactsSource,
  installCustomProviders,
  notifyCustomProvidersChanged,
  validateCustomProviderInput,
} from '@/core/config/custom-providers';
import { type Db, db as defaultDb } from '@/db/client';
import { custom_provider } from '@/db/schema';
import { ApiError } from '@/kernel/http';

const SELECTION = {
  id: custom_provider.id,
  display_name: custom_provider.display_name,
  base_url: custom_provider.base_url,
  api_key_env: custom_provider.api_key_env,
  protocol: custom_provider.protocol,
  created_at: custom_provider.created_at,
  updated_at: custom_provider.updated_at,
} as const;

async function selectRecords(db: Db): Promise<readonly CustomProviderRecord[]> {
  const rows = await db.select(SELECTION).from(custom_provider);
  return rows
    .map(customProviderRecordFromRow)
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function reinstallRegistry(db: Db): Promise<void> {
  installCustomProviders(await selectRecords(db));
}

export interface CustomProviderWriteResult {
  readonly provider: CustomProviderRecord;
  readonly catalog: CustomProviderRefreshOutcome;
}

/** Create or replace one definition, then trigger the catalog change handler. */
export async function putCustomProviderRow(
  input: { slug: string } & Omit<CustomProviderDefinition, 'id'>,
  db: Db = defaultDb,
): Promise<CustomProviderWriteResult> {
  const definition = validateCustomProviderInput(input);
  const id = customProviderIdFor(input.slug);
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: custom_provider.id })
      .from(custom_provider)
      .where(eq(custom_provider.id, id))
      .for('update')
      .limit(1);
    if (existing.length === 0) {
      const count = await tx.select({ id: custom_provider.id }).from(custom_provider);
      if (count.length >= CUSTOM_PROVIDER_LIMIT) {
        throw new ApiError(
          'custom_provider_limit_reached',
          `at most ${CUSTOM_PROVIDER_LIMIT} custom providers are supported`,
          422,
        );
      }
      const [created] = await tx
        .insert(custom_provider)
        .values({
          id,
          display_name: definition.displayName,
          base_url: definition.baseUrl,
          api_key_env: definition.apiKeyEnv,
          protocol: definition.protocol,
          created_at: now,
          updated_at: now,
        })
        .returning(SELECTION);
      return created;
    }
    const [updated] = await tx
      .update(custom_provider)
      .set({
        display_name: definition.displayName,
        base_url: definition.baseUrl,
        api_key_env: definition.apiKeyEnv,
        protocol: definition.protocol,
        updated_at: now,
      })
      .where(eq(custom_provider.id, id))
      .returning(SELECTION);
    return updated;
  });
  await reinstallRegistry(db);
  const catalog = await notifyCustomProvidersChanged({ kind: 'put', id });
  return { provider: customProviderRecordFromRow(row), catalog };
}

/**
 * Delete one definition. The change handler prunes its catalog footprint;
 * task configs still naming it fail closed at the next resolution.
 */
export async function deleteCustomProviderRow(
  slug: string,
  db: Db = defaultDb,
): Promise<{ removed: boolean; catalog: CustomProviderRefreshOutcome }> {
  const id = customProviderIdFor(slug);
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(custom_provider)
      .where(eq(custom_provider.id, id))
      .returning({ id: custom_provider.id });
    return rows.length > 0;
  });
  if (!deleted) {
    return { removed: false, catalog: { outcome: 'not_wired' } };
  }
  await reinstallRegistry(db);
  const catalog = await notifyCustomProvidersChanged({ kind: 'delete', id });
  return { removed: true, catalog };
}

export interface CustomProviderPanelRow {
  id: string;
  display_name: string;
  base_url: string;
  api_key_env: string;
  protocol: 'openai-completions' | 'anthropic-messages';
  key_present: boolean;
  auth: string;
  runnable_models: string[];
  unknown_models: string[];
  findings: number;
}

/**
 * Panel projection from the table + the injected catalog facts source.
 * `facts_injected: false` (tests, unwired tooling) yields honest unprobed
 * rows rather than fabricated catalog state.
 */
export async function listCustomProviderPanelRows(
  db: Db = defaultDb,
): Promise<{ providers: CustomProviderPanelRow[]; facts_injected: boolean }> {
  const records = await selectRecords(db);
  installCustomProviders(records);
  const facts = getCustomProviderCatalogFactsSource()?.();
  const providers = records.map((record) => {
    const row = facts?.get(record.id);
    return {
      id: record.id,
      display_name: record.displayName,
      base_url: record.baseUrl,
      api_key_env: record.apiKeyEnv,
      protocol: record.protocol,
      key_present: Boolean(process.env[record.apiKeyEnv]),
      auth: row?.auth ?? 'unprobed',
      runnable_models: [...(row?.runnableModels ?? [])],
      unknown_models: [...(row?.unknownModels ?? [])],
      findings: row?.findings ?? 0,
    };
  });
  return { providers, facts_injected: facts !== undefined };
}
