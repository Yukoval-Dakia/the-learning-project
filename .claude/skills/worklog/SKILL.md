---
name: worklog
description: 追加式 TSV 决策日志：每行 = 一个决策 + 证据指针，供长 run/overnight/多 lane 工作留审计轨迹。Use when running an unattended or multi-step effort where decisions must be auditable later, or when user asks "show your work" / "留痕".
---

# Worklog — 决策证据日志

pstack `show-me-your-work` 移植。一份 append-only TSV，一行一决策。

## 位置

- 常规：`.remember/worklog-<task-or-lane>.tsv`（本机留痕，不入仓）。
- 需要进审计链的大活（迁移、port、跨 session）：`docs/planning/evidence/<date>-<name>.worklog.tsv`，入仓。

## 格式

每行，tab 分隔：

```
<ts>	<step-or-decision>	<evidence-pointer>	<result>
```

- `evidence-pointer`：可解引用——commit SHA、PR 号、`file:line`、命令+输出摘要、artifact 路径（截图/trace/JSON）。**不接受 "done" / "it works" / 空指针**。
- `result`：`VERIFIED` / `NOT VERIFIED` / `INCONCLUSIVE` / `reverted` / `open` / `skip:<reason>`。

## 规则

- 只追加不改历史；推翻的决定新起一行写 `reverted` + 指向新证据。
- 一个可验证 unit = 至少一行（change → check → row）。
- 收尾时由另一个 lens（oracle 或换 session 的 reviewer）对照日志 vs 实际 diff/transcript 审一遍证据指针可解性。
