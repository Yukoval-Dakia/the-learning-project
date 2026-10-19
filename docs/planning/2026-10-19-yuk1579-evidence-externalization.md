# YUK-1579 批量证据外置 — 第一批（YUK-1358 Start 家族）— 2026-10-19

Branch `docs/yuk-1579-evidence-externalization`，base `696449125b53b0c35a210dbc9a57292f014712de`（origin/main）。
任务：把历史批量验收证据永久外置到仓库外 artifact 卷；git 只留结论、命令、revision、路径、SHA256。
历史阶段 #1839 只建立外部副本与规则，未删除 git 内容；2026-10-20 协调线批准
首批删除，当前分支已执行（见末节），尚待本 PR 合入 main。

## 授权与边界

- Owner 委托经架构线协调者（parent）转达：coordinator 已 APPROVED 全线外置政策
  （外置永久保留；git 历史不动；HEAD 删除须逐批提交、协调线见到具体批次前不得删）。
- 本 child 未获 push/PR/merge 授权；未运行本地测试套件/DB/Docker/runtime/provider/付费调用。
- Exclusive no-touch 均未触碰（scripts/audit-capability-boundaries.ts、search-bank 族、
  practice/public.ts、付费链、src/server/ai、tests、CI gating）。

## 库存与批次选择

原始基线 `696449125` 的 `docs/planning/evidence/` 库存为 604 文件（包含顶层散文件）；
下述仅保留批次的精确字节量，避免混用 MB/MiB。顶层散文件中，
其中 `2026-10-10-pi-tool-loop-*`、`2026-09-19-pi-adapter-*`、`2026-10-18-opencode-go-*`
被 `src/server/ai/{providers.ts,AGENTS.md,opencode-go.ts}` 引用为 live actual-output
封存，**本批不纳入删除提案**。

第一批选 YUK-1358 Start 家族全部 5 个子目录，理由：

1. 同一 issue 家族、对应切片已合并（PR1609/1620/1622/1623/1626；不代表 YUK-1358 整体迁移验收完成）；
2. 全仓引用面仅叙事 markdown（planning docs / PLAN.md / `.remember/now.md`），
   无 scripts、无 CI、无测试 fixture、无 runtime 输入消费；
3. 体量为各家族之最（11.0 MiB，含 4.3MB/3.0MB/1.9MB 三个 runtime tar.gz）。

## 执行的完整操作（rerunnable，已修正）

历史事实：本批实际执行时对干净工作树用 `cp -Rp` 复制到 `$EXT/docs/planning/evidence/`，
随后逐文件 SHA256 双向 diff 全等。该写法对 head-addressed 封存目录**不是可重跑形式**：
重跑会静默覆盖已封存字节。以下为修正后的可重跑程序——导出源固定为 git revision
（不依赖工作树状态），目标按 `<head>/evidence-export` 寻址且**必须不存在**，已存在即
拒绝；外部布局以仓库路径 `docs/planning/evidence/` 为根镜像。

```bash
(
set -euo pipefail
REV=696449125b53b0c35a210dbc9a57292f014712de   # 固定源 git revision
DEST=/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1579/$REV/evidence-export
mkdir -p "$(dirname "$DEST")"
# 原子创建最终目录；已存在（包括符号链接）就失败，不能覆盖封存内容。
mkdir "$DEST" || { echo "refuse: cannot create fresh $DEST" >&2; exit 1; }
for d in yuk1358-start-event-detail yuk1358-start-notes-list yuk1358-start-agent-notes \
         2026-10-09-yuk1358-start-admin-controls 2026-10-08-yuk1358-start-workbench; do
  git archive "$REV" "docs/planning/evidence/$d" | tar -x -C "$DEST"
done
# 在 $DEST/docs/planning/evidence 下生成逐文件 shasum -a 256 manifest（条目相对该目录），
# 与 git 树同相对路径 manifest diff —— 全等
)
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

叙事引用者（#1839 合入时全部仍指向 git 内路径；批次一删除 PR 已把全部活跃引用
改指外部封存路径并附逐文件 `sha256`——47 处 markdown 链接 + 1 处行内代码路径 +
1 处代码块命令路径 + 1 处目录引用；PLAN.md/`.remember/now.md` 经核实只引用叙事
文档名、不指向被删 evidence 路径，未改动）：

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
- 「old responsibilities actually removed」：#1839 仅建立已批准的全线外置规则；
  本次在协调线逐批批准后，从本分支 HEAD 移除 172 个批量证据文件，保留历史对象。
- 失败/事务/锁/兼容行为：无 runtime 代码改动；live seal、fixture、CI 语义、
  git 历史全部原样。

## 提交协调线的 HEAD 删除提案（已于批次一执行，见末节执行记录）

已批准并从 HEAD 删除以下 5 个 git 路径，共 172 文件 / 11,552,302 字节
（≈11.0 MiB；口径为 HEAD 工作树字节，
git 历史对象仍占用，clone/fetch 体积不降）：

| git 路径 | 文件 | 字节 |
| --- | --- | --- |
| `docs/planning/evidence/yuk1358-start-event-detail/` | 68 | 4,980,793 |
| `docs/planning/evidence/yuk1358-start-notes-list/` | 12 | 3,309,938 |
| `docs/planning/evidence/yuk1358-start-agent-notes/` | 56 | 2,853,637 |
| `docs/planning/evidence/2026-10-09-yuk1358-start-admin-controls/` | 26 | 236,637 |
| `docs/planning/evidence/2026-10-08-yuk1358-start-workbench/` | 10 | 171,297 |

复制与核验已完成、指针已建立（本文件 +
`evidence-export-pointers.md`）。删除由协调线按批次批准后执行（批次一已执行，
见末节）；既有 git 历史不重写。

## 真实指标与 NOT_RUN

- 指标：本分支删除批准清单 172 文件 / 11,552,302 字节，修改 11 份叙事或指针
  文档；不承诺完整 clone/fetch 缩小。全部生产源码、测试、live seal 保留。
- 验证：逐文件 SHA256、字节数、删除清单与 manifest 全等、活跃引用和外链哈希。
- NOT_RUN：未跑测试/DB/Docker/runtime/provider；未部署。本文初版外置记录对应
  #1839，末节才是本次批准后的删除记录，不能把旧记录当当前未删除状态。

父级复核：172/172 文件均 git tracked；source/外部 SHA256 与 manifest 全等，所选五目录无漏项；总计 11,552,302 字节。manifest 路径相对其下的 `docs/planning/evidence/`，复验须先切到该目录，再 `shasum -a 256 -c ../../../SHA256SUMS.txt`。父级原始结果在外部 `evidence-export/parent-verification.json`。

## 批次一 HEAD 删除执行记录（2026-10-20，分支 `docs/yuk-1579-evidence-batch-one`）

协调线批准后由独立 worktree 实施：

- 删除前复核：`SHA256SUMS.txt` 自身 digest `02a483a4841843ace8d7b8fb0f1649d7d94cd1108ecb0903343b2c2b2ad1638e`
  不变；对封存外部副本 `shasum -a 256 -c` 172/172 OK；对当前 HEAD（`71986f2244`）
  工作树同 manifest `shasum -a 256 -c` 172/172 OK——HEAD 字节与封存逐文件全等。
- manifest 恰好 172 条且全部落在批准五目录内，无越界条目；五目录内无 manifest
  外文件。
- `git rm -r` 仅删除批准清单 172 文件；无顺带清理。删除后 HEAD 工作树减少
  11,552,302 字节；git 历史对象仍占用，clone/fetch 体积不降（不修史）。
- 活跃引用改写：9 篇 `docs/planning/` 叙事文档共 50 处（47 markdown 链接目标改
  外部绝对路径 + `sha256:` 链接标题取 manifest 逐文件哈希；1 处行内代码路径 +
  1 处代码块命令路径同样外置并注 SHA-256；1 处目录引用改外部目录并注明 manifest
  前缀条目数）。每篇文档标题下增一行迁移约定说明。历史叙事保留。
- `evidence-export-pointers.md` Batch 1 节状态由「未删除」更新为已删除登记；
  顶部新增「重跑导出只允许写入不存在的新 head-addressed 目标，已存在一律拒绝」。
- PLAN.md/`.remember/now.md` 不含指向被删 evidence 路径的引用（仅含同名叙事文档
  链接），按边界未改动。
- bulk 复核输出（逐文件校验日志、引用清单、删除清单）封存于
  `architecture-deepening/YUK-1579/696449125b53b0c35a210dbc9a57292f014712de/batch-one-head-removal/`。
- NOT_RUN：无测试改动；未跑测试/DB/Docker/runtime/provider/付费；未 push/PR/merge
  （父级验收与独立 review）。
