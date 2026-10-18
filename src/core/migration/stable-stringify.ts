// ====================================================================
// 纯确定性 JSON 序列化（无 node:crypto 依赖）
// ====================================================================
//
// 从 canonical.ts 拆出：core/schema/assessment 的判分 / 作答输入会被前端
// 引用（展示层解析等），这里不能牵进 node:crypto，否则 Vite dev 服务器无法
// 启动。canonical.ts 继续 re-export，服务端调用方行为不变。

/** 确定性 JSON 序列化：对象键按字典序，数组保序（数组顺序是事实）。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return normalizeScalar(value);
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value instanceof Date) {
    // DB 时间戳是事实；统一为 ISO UTC 毫秒形态，杜绝本地时区漂移。
    return value.toISOString();
  }
  const record = value as Record<string, unknown>;
  // null 原型累加器（P2-A）：普通对象上 `out['__proto__'] = v` 会触发原型 setter
  // ——既丢失该键文造成哈希碰撞，又可能污染原型。null 原型对象没有该 accessor，
  // 赋值即创建普通自有属性；JSON.stringify 对其照常序列化自有键。
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    // undefined 键直接丢弃（与 JSON.stringify 语义一致）：{a:1,b:undefined} 与
    // {a:1} 哈希相同，避免跨运行形状漂移。
    if (entry === undefined) continue;
    out[key] = sortValue(entry);
  }
  return out;
}

function normalizeScalar(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON 无法表达 NaN/Infinity；DB 不产这些值，防御性归一避免跨运行差异。
    return String(value);
  }
  if (typeof value === 'bigint') {
    // bigint 列（如 event.dispatch_seq mode:'number' 不会出现，但 sql 原读可能）
    // 以十进制字符串进入哈希，与 PG 解析形态一致。
    return value.toString();
  }
  return value;
}
