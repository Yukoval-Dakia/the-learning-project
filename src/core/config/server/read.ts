// 事务内配置读（config 唯一允许碰 DB 的读面）。使用调用方 Tx：不另开事务、
// 不改隔离级别/锁序，读端不擅自 FOR UPDATE。15s 快照（store.ts）不是资金事实，
// 资金/授权判定必须走这里。
import { eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { system_config } from '@/db/schema';
import { type ConfigSource, type ConfigValue, resolveKeyDef } from '../registry';

/**
 * 事务读的失败原因。config 层不认识各 capability 的错误码：消费者把
 * ConfigTxReadError 映射成自己的拒绝语义（预算 = budget_read_unavailable）。
 */
export type ConfigTxReadFailure =
  | 'unregistered_key'
  | 'missing_transaction_policy'
  | 'unsupported_transaction_policy'
  | 'unsupported_env_mode'
  | 'invalid_db_row'
  | 'invalid_env';

export class ConfigTxReadError extends Error {
  readonly failure: ConfigTxReadFailure;
  readonly key: string;

  constructor(failure: ConfigTxReadFailure, key: string) {
    super(`config tx read failed: ${failure} (${key})`);
    this.name = 'ConfigTxReadError';
    this.failure = failure;
    this.key = key;
  }
}

/**
 * 事务读结果。与 store.ResolvedConfig 的区别：revision 显式 null（无 DB 行），
 * 调用方原样持久化；省略 updatedAt——当前无消费者，需要时再加列读取。
 */
export interface ResolvedTxConfig {
  value: ConfigValue | undefined;
  source: ConfigSource;
  /** DB 行 revision；env / code default 为 null。 */
  revision: number | null;
}

/**
 * 在调用方事务里解析一个声明了 transactionRead 的键。分层固定为
 * DB 行 > env > codeDefault，且只接受 envMode='fallback'。
 *
 * 本实现只支持预算键的既有契约：invalidEnv='error'（显式但解析不了的 env
 * 失败关闭，不回落默认值）、expiredRow='ignore'（不消费 expires_at，预算行
 * 过期仍是事实）。声明其它组合的键一律拒绝，不静默换语义——TTL 生效是独立的
 * 资金行为变更，到时候在这里显式实现。
 *
 * DB 行存在但 schema 解析失败一律失败关闭（旧实现即如此，不回落到 env/default）。
 */
export async function readConfigTx(
  tx: Tx,
  key: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedTxConfig> {
  const def = resolveKeyDef(key);
  if (!def) throw new ConfigTxReadError('unregistered_key', key);
  const policy = def.transactionRead;
  if (!policy) throw new ConfigTxReadError('missing_transaction_policy', key);
  if (policy.invalidEnv !== 'error' || policy.expiredRow !== 'ignore') {
    throw new ConfigTxReadError('unsupported_transaction_policy', key);
  }
  if ((def.envMode ?? 'fallback') !== 'fallback') {
    throw new ConfigTxReadError('unsupported_env_mode', key);
  }

  const [row] = await tx
    .select({ value: system_config.value, revision: system_config.revision })
    .from(system_config)
    .where(eq(system_config.key, key))
    .limit(1);

  if (row) {
    const parsed = def.schema.safeParse(row.value);
    if (!parsed.success) throw new ConfigTxReadError('invalid_db_row', key);
    return { value: parsed.data as ConfigValue, source: 'db', revision: row.revision };
  }

  const env = options.env ?? process.env;
  const envRaw = def.envName != null ? env[def.envName] : undefined;
  if (envRaw !== undefined) {
    const envParsed = def.envParse ? def.envParse(envRaw) : envRaw;
    const validated = def.schema.safeParse(envParsed);
    if (validated.success) {
      return { value: validated.data as ConfigValue, source: 'env', revision: null };
    }
    throw new ConfigTxReadError('invalid_env', key);
  }

  return { value: def.codeDefault, source: 'code-default', revision: null };
}
