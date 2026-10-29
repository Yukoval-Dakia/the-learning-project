# YUK-1527 冻结样本 MANIFEST

冻结对象：`tuning-set.json` / `validation-set.json` / `paraphrase-set.json`（同目录）。
组合契约、层定义、补齐程序、纪律条款见
`docs/planning/2026-10-29-yuk1527-cluster-margin-plan.md` §1。

## 冻结状态

**pending_external_fill（2026-10-29）**：三个集合仅含组合契约配额与仓库内可考锚点，
全部条目未 frozen。

## 来源与路径缺口

| 来源 | 状态（2026-10-29 勘验） |
|---|---|
| `tlp-status/review/stage1-yuk1516-calibration`（PM 指定源） | 不在本仓库；外置卷 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/`，本 worktree（Linux）不可达 |
| `tlp-status/review/stage1-k7-paid-vector/report.md`（YUK-1516 报告） | 同上，不可达；数字仅经仓库内文档转引 |
| `docs/planning/2026-10-17-yuk1516-bank-vector-retrieval-threshold.md` | 在仓库；两条实测锚点（文言断句 present 0.422/0.675；离子方程式 absent 0.436/0.546）已入 tuning-set |
| `scripts/fixtures/bank-vector-calibration.sample.json` | 在仓库；锚点 query 同源（expected id 占位） |

本轮不编造数字：除上表转引的仓库内文档数字外，三个集合不含任何距离/指标数值。

## SHA256 登记（补齐后由 lead 填写）

| 文件 | SHA256 | 冻结时间 | 补齐记录（缺口/扩展标注） |
|---|---|---|---|
| tuning-set.json | （待登记） | — | — |
| validation-set.json | （待登记） | — | — |
| paraphrase-set.json | （待登记） | — | — |

## 纪律条款（binding）

1. 三个文件全部条目 frozen 且上表 SHA256 登记之前，任何调参运行不得开始。
2. 冻结后三个文件只读；任何修改 = 作废重冻（新目录 + 新 MANIFEST）。
3. 验证集与换说法集各只看一次；看过之后再调参 ⇒ 该集作废，须重新标注替换。
4. 验证集/换说法集文件与调参执行输入物理隔离（分文件、不进调参脚本输入路径）。
5. 配额供不满某层时在此登记缺口与实际条数，不得静默降配。
