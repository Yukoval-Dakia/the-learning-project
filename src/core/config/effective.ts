// consumer-effective 配置事实的共享行类型。
//
// effective 值**只能来自调用真实 reader**（各 capability 的 config-effective-facts
// 模块产出），读面永不复制 reader 的 clamp/floor/fallback 规则：否则 store 报
// BACKUP_IMPORT_MAX_BYTES=1，reader 却因 1MB 地板回退到 1_000_000_000，读面虚报生效值。
// reader 输出不是单一标量（按 lane / 按会话动态解析）的键只给 note，不伪造 value。
import type { ConfigValue } from './registry';

/** 单键 effective 事实：value 缺席 = 该键无单一标量 effective（见 note）。 */
export interface ConfigEffectiveFact {
  readonly value?: ConfigValue | null;
  readonly note?: string;
}

export type ConfigEffectiveFacts = Readonly<Record<string, ConfigEffectiveFact>>;
