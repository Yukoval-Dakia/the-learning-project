// YUK-521 (A4 强度轴) — completion auto-apply 事件 action 常量的单一真相。
//
// 写侧（proposal-tools.ts 的 completion auto-apply 工具）与读侧（auto-applied-read.ts
// 的 A 档读模型）此前各硬编码一份字符串；若任一侧改了 action 命名而另一侧没跟，读模型的
// where 子句会静默失配 → A 档卡列表永远返空（漂移无声）。抽到此处共享，两边 import 同一常量。

/** completion 自动物化成功落地（A 档读模型锚 + 撤销追溯）。 */
export const COMPLETION_AUTOAPPLY_ACTION = 'experimental:completion_autoapply';
/** completion 退回 B（熔断 tripped 或 apply 失败）的纯 telemetry 锚。 */
export const COMPLETION_AUTOAPPLY_SKIPPED_ACTION = 'experimental:completion_autoapply_skipped';
