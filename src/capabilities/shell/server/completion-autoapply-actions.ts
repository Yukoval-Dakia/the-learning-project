// completion auto-apply 事件的 action 常量。YUK-525 起写入侧已改为人工审批，
// 读模型仍按这些名字识别历史锚。

/** completion 自动物化成功的历史锚（A 档读模型 + 撤销追溯）。 */
export const COMPLETION_AUTOAPPLY_ACTION = 'experimental:completion_autoapply';
/** completion 退回 B 的历史 telemetry 锚。 */
export const COMPLETION_AUTOAPPLY_SKIPPED_ACTION = 'experimental:completion_autoapply_skipped';
