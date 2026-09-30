// YUK-1007 — consumer-effective 配置事实的共享行类型。
//
// 背景（review P1/P2 实证）：`GET /api/admin/config` keys[] 报告的 value 是
// store 解析值（configured/resolved），而部分 consumer reader 在其之上还有
// 正规化（clamp / floor / fallback / 降级）——例如 BACKUP_IMPORT_MAX_BYTES=1
// 解析为 1，但 maxBackupUploadBytes() 因 1MB 地板回退 1_000_000_000。读面若
// 只报 configured 值就是虚报生效值。
//
// 修正契约：effective 值**只能来自调用真实 reader**（本类型由各 capability 的
// config-effective-facts 模块产出），读面永不复制 reader 规则。reader 输出不是
// 单一标量（如按 lane / 按会话动态解析）的键只给 note，不伪造 value。
import type { ConfigValue } from './registry';

/** 单键 effective 事实：value 缺席 = 该键无单一标量 effective（见 note）。 */
export interface ConfigEffectiveFact {
  readonly value?: ConfigValue | null;
  readonly note?: string;
}

export type ConfigEffectiveFacts = Readonly<Record<string, ConfigEffectiveFact>>;
