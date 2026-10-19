# 批量证据外置指针 — 权威登记

按 AGENTS.md「批量证据外置」规则登记每批已外置的证据。git 只留本指针；
字节级内容与全量 manifest 永久存放外部路径。新增批次在此追加一节，不改旧节。

外部根：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/`
（架构线子路径 `architecture-deepening/`）。删除任何批次前须协调线逐批确认。

## Batch 1 — YUK-1358 Start 家族验收证据（2026-10-19）

- 来源 HEAD：`696449125b53b0c35a210dbc9a57292f014712de`（origin/main）
- 外部目录：`architecture-deepening/YUK-1579/696449125b53b0c35a210dbc9a57292f014712de/evidence-export/docs/planning/evidence/`
- 覆盖 manifest：`evidence-export/SHA256SUMS.txt`
  （digest `02a483a4841843ace8d7b8fb0f1649d7d94cd1108ecb0903343b2c2b2ad1638e`）
- 规模：5 个目录、172 文件、11,552,302 字节；源/目标逐文件 SHA256 全等，
  字节数全等。
- 批次内容（git 路径 → 外部同相对路径）：
  - `docs/planning/evidence/yuk1358-start-event-detail/`（68 文件 / 4,980,793 B，PR1623 已合 main 7472f4395）
  - `docs/planning/evidence/yuk1358-start-notes-list/`（12 文件 / 3,309,938 B，PR1626 已合 main 04232aaf10）
  - `docs/planning/evidence/yuk1358-start-agent-notes/`（56 文件 / 2,853,637 B，PR1622 已合 main 6212a4560）
  - `docs/planning/evidence/2026-10-09-yuk1358-start-admin-controls/`（26 文件 / 236,637 B，PR1620 已合 main 10df1a471）
  - `docs/planning/evidence/2026-10-08-yuk1358-start-workbench/`（10 文件 / 171,297 B）
- HEAD 删除状态：**未删除**（提案见
  `docs/planning/2026-10-19-yuk1579-evidence-externalization.md`，待协调线确认批次）。
