# YUK-1579 批量证据外置 — 第一批（YUK-1358 Start 家族）— 2026-10-19

Branch `docs/yuk-1579-evidence-externalization`，base `696449125b53b0c35a210dbc9a57292f014712de`（origin/main）。
任务：把历史批量验收证据永久外置到仓库外 artifact 卷；git 只留结论、命令、revision、路径、SHA256。
本批**不删除任何 git 内容**；删除提案交协调线逐批确认（AGENTS.md 新规则）。

## 授权与边界

- Owner 委托经架构线协调者（parent）转达：coordinator 已 APPROVED 全线外置政策
  （外置永久保留；git 历史不动；HEAD 删除须逐批提交、协调线见到具体批次前不得删）。
- 本 child 未获 push/PR/merge 授权；未运行本地测试套件/DB/Docker/runtime/provider/付费调用。
- Exclusive no-touch 均未触碰（scripts/audit-capability-boundaries.ts、search-bank 族、
  practice/public.ts、付费链、src/server/ai、tests、CI gating）。

## 库存与批次选择

`docs/planning/evidence/` 现有 604 文件 / 20MB（另有 179 个顶层散文件 5.5MB，
其中 `2026-10-10-pi-tool-loop-*`、`2026-09-19-pi-adapter-*`、`2026-10-18-opencode-go-*`
被 `src/server/ai/{providers.ts,AGENTS.md,opencode-go.ts}` 引用为 live actual-output
封存，**本批不纳入删除提案**）。

第一批选 YUK-1358 Start 家族全部 5 个子目录，理由：

1. 同一 issue 家族、对应切片已合并（PR1609/1620/1622/1623/1626；不代表 YUK-1358 整体迁移验收完成）；
2. 全仓引用面仅叙事 markdown（planning docs / PLAN.md / `.remember/now.md`），
   无 scripts、无 CI、无测试 fixture、无 runtime 输入消费；
3. 体量为各家族之最（11.0 MiB，含 4.3MB/3.0MB/1.9MB 三个 runtime tar.gz）。

## 执行的完整操作（rerunnable）

```bash
EXT=/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1579/696449125b53b0c35a210dbc9a57292f014712de/evidence-export
mkdir -p "$EXT/docs/planning/evidence"
for d in yuk1358-start-event-detail yuk1358-start-notes-list yuk1358-start-agent-notes \
         2026-10-09-yuk1358-start-admin-controls 2026-10-08-yuk1358-start-workbench; do
  cp -Rp "docs/planning/evidence/$d" "$EXT/docs/planning/evidence/"
done
# 源/目标各生成逐文件 shasum -a 256 manifest 后 diff —— 全等
```

源不移动、不删除；未复制 secrets/env（无 .env 文件；secret 模式扫描命中均为
build 产物 chunk 名与测试名等误报，已逐条人工核过）。

## 验证结果（全部实测，非推断）

- 文件数：源 172 = 目标 172。
- 逐文件 SHA256：源/目标 manifest `diff` 零差异（172/172 全等）。
- 字节总数：两侧均 11,552,302。
- 外置全量 manifest：`evidence-export/SHA256SUMS.txt`，其自身 SHA256
  `02a483a4841843ace8d7b8fb0f1649d7d94cd1108ecb0903343b2c2b2ad1638e`。
- git 内指针：`docs/planning/evidence-export-pointers.md` Batch 1 节。

## 引用地图（引用者 → 批次目录）

叙事引用者（今日全部仍指向 git 内路径，未断链；若协调线批准删除，后续批次 PR
负责把这些链接改指外置路径或指针文件）：

- `PLAN.md`、`.remember/now.md`（看板/交接叙事）
- `docs/planning/2026-10-09-yuk1358-start-{event-detail,notes-list,agent-notes}-*.md`
- `docs/planning/2026-10-09-yuk1358-start-admin-controls-{parent,implementation}.md`
- `docs/planning/2026-10-08-yuk1358-start-workbench-handoff.md`
- `docs/planning/2026-10-07-yuk1359-exit-inventory.md`（跨线引用 1 处）

代码/脚本/CI 消费者：**无**（grep scripts/ src/ server/ web/ .github/ 仅命中
上述 src/server/ai 的 live seal 顶层散文件，不在本批）。

## 维护场景 before/after（真实场景，非假设量纲）

1. 验收争议复核：此前证明 YUK-1358 event-detail 15 个 DB 测试真实跑过，需要
   checkout 对应 merged SHA 后在 git 树内翻 68 文件/4.9MB；历史对象仍属于完整 clone 的内容。之后：同一证明在外置卷按 issue+head 定位，`shasum -a 256 -c` 对
   SHA256SUMS.txt 即可验真，git 内一行指针足够。
2. 后续 lane 复用旧 runtime 记录：YUK-1359 退出清单工作若需 start-agent-notes
   的 runtime acceptance tar.gz（1.9MB），此前需从 git 对象里捞大二进制；之后
   直接读外置卷同相对路径（字节级全等已证），HEAD 批准删除后工作树不再携带；历史对象仍保留，完整 clone/fetch 体积不据此承诺下降。

## 责任迁移实况

- 「caller knowledge removed」：仓库消费者从「须知道 bulk 证据在 git 树内某深层
  路径」变为「只须知道指针文件 + 外部根约定」；接口缩为一条登记行 + 一个 digest。
- 「old responsibilities actually removed」：git HEAD 的 bulk 字节承载**尚未移除**，
  这是本批设计如此——child 无删除授权，删除以协调线确认为前置（见下）。
  本 PR 提议把已批准的外置政策写入 AGENTS，尚未合入生效；不声称此前存在必须入库的规则。
- 失败/事务/锁/兼容行为：无 runtime 代码改动；live seal、fixture、CI 语义、
  git 历史全部原样。

## 提交协调线的 HEAD 删除提案（未执行）

若批准，从 HEAD 删除以下 5 个 git 路径，共 172 文件 / 11,552,302 字节
（≈11.0 MiB，`docs/planning/evidence/` 总量的 ~57%）：

| git 路径 | 文件 | 字节 |
| --- | --- | --- |
| `docs/planning/evidence/yuk1358-start-event-detail/` | 68 | 4,980,793 |
| `docs/planning/evidence/yuk1358-start-notes-list/` | 12 | 3,309,938 |
| `docs/planning/evidence/yuk1358-start-agent-notes/` | 56 | 2,853,637 |
| `docs/planning/evidence/2026-10-09-yuk1358-start-admin-controls/` | 26 | 236,637 |
| `docs/planning/evidence/2026-10-08-yuk1358-start-workbench/` | 10 | 171,297 |

复制与核验已完成、指针已建立（本文件 +
`evidence-export-pointers.md`）。删除执行须另批授权；既有 git 历史不重写。

## 真实指标与 NOT_RUN

- 指标：外置 11,552,302 字节 / 172 文件（实测 stat 求和）；本 PR 给 git HEAD 增
  3 个小文本（AGENTS 规则 + 本文件 + 指针 manifest，约 8KB）；git HEAD 若批准
  删除批次一可减 11,552,302 字节。不把文件数/体积本身当深化成果，深化在
  「证据生命周期责任」从 git 树移到外置卷 + 指针。
- 验证方式：逐文件 SHA256 diff、字节数求和、外部 manifest digest 记录；
  子任务未跑 build；父级按仓库 pre-PR 规则补跑，结果随 PR 更新。
- NOT_RUN：未删除任何 git 文件；未跑任何测试/DB/Docker/runtime/provider；
  未 push；未改 scripts audit 代码（另一 child 所有）；未更新 PLAN.md/.remember
  （parent 集成所有）。

父级复核：172/172 文件均 git tracked；source/外部 SHA256 与 manifest 全等，所选五目录无漏项；总计 11,552,302 字节。manifest 路径相对其下的 `docs/planning/evidence/`，复验须先切到该目录，再 `shasum -a 256 -c ../../../SHA256SUMS.txt`。父级原始结果在外部 `evidence-export/parent-verification.json`。
