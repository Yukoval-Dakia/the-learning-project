# YUK-567 — Teaching Brief 判断改写交互补充

状态：Approved（owner 于 2026-07-23 批准“内联编辑（推荐）”）

本补充收窄并兑现 `2026-07-19-teaching-brief-contract.md` §2.1 的既有约束：accepted/edit 后 `finding.claim_md` 优先使用 accept rate payload 的 `corrected_claim_md`，且 `knowledge_id`、`cause_category` 不可编辑。

## 组件与边界

这是 `/today` 上既有、默认可见 `TeachingBriefBand` 中的**内联编辑状态**；不是 route、modal 或 drawer。仅 primary Teaching Brief finding 可编辑。`PrepDeskConjectures` 不提供同等入口，也不改动。

## 交互契约

- finding 态显示 `改写判断`。触发后，在原判断位置显示带可见标签的 textarea，并以当前 `claim_md` 预填。
- 主操作为 `保存并验证`；次操作为 ghost `取消`。
- textarea 接受完整键盘 Tab 路径至保存与取消。Escape 等同取消：丢弃本次输入并把焦点还给 `改写判断`。
- 仅发送严格的 accept payload：`{ decision: 'accept', corrected_payload: { claim_md } }`。`claim_md` 提交前 trim，长度 1–280；不得发送或编辑 `knowledge_id`、`cause_category`。
- trim 后与原判断相同、空白或超长时不可提交。请求 pending 时 textarea、保存、取消及 Escape 相关动作全部禁用。
- 不做 optimistic transition。保存失败时保留 textarea 当前文本和 finding，显示 `role="alert"` 的原位错误，并允许重试。
- 保存成功后沿用既有 finding → `probe_ready` 刷新行为，并将焦点移至新出现的 prepared/probe heading。
- 该动作只是 conjecture accept/edit + 同事务 probe serve；不触发 FSRS 或任何复习排程。
