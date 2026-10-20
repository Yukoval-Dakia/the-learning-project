# 稳定公开契约与兼容转发分类：待协调裁定

状态：**提案，未批准、未实施**。仅暂停 #1895 合并，不暂停其他架构片。
原依据是已批准的
[防回退方案 §2](2026-10-20-architecture-no-regression-proposal.md)；
本提案不自行撤销其硬门。沿用 YUK-1579，不开平行票或第三审。
Sidekick 原评论：`d9dba13e-bfea-4769-9868-19aaa683139f`，
父评论 `c24a7fb9-7a83-4c65-90b2-e65b1eec8c1a`；此前 `undefined` 不是有效引用。

## 事实与影响

审计固定 `c1253cb14106ff66cfc6992fc4c65a6ad105c429`：
`pass-through-sites.ts:387–399` 收集 value re-export，
`:592–614` 生成站点，`:627–650` 比较新增；
`:794–811` 只提供最长 14 天的 compatShims 出口。
`audit-architecture-deepening.ts:1404–1459` 对全 src/server/web 使用它。
因此“语法转出”被直接等同于“应删除的兼容层”；当前基线 `+0 new`
只能说明存量被豁免，不能证明这项分类正确。

已批准 §2 一面要求只经 public/kernel，另一面要求阻断纯转发，并明确
“无法静态证明深度的情况交独立审查”。稳定契约应如何表达尚未被单独裁定；
不能由作者借文件名或自述 owns 自动放行，也不能要求给 public 塞无意义逻辑。

| 真实对象 | 责任及调用事实 | 建议判定 |
|---|---|---|
| #1837 `de061af07afece563d0f350a5e101a3e395c6c58` 的 knowledge/public.ts:69–72 → frontier-read.ts:220–352 `learnableFrontierResolved` | knowledge 实现拥有闭包查询、溢出/稀疏/稠密三态、0.7+4 掌握门及排序；practice/learnable-frontier.ts:5、26–27 经公开口调用。是实际 owner 向外提供完整决策 | 合法长期契约候选，应由独立语义判断确认；不能强制 14 天退役 |
| 同提交 practice/server/learnable-frontier.ts:8–9 的旧符号再导出 | 原实现已移至 knowledge；practice/public.ts:60–61 保持旧绑定。此处不拥有 resolver 决策，只保留旧入口 | 兼容候选；如是新引入，仍须真实旧 consumer、退出条件、Linear、批准及 ≤14 天。base 存量不追罚 |
| `c1253cb14` kernel/placement-jobs.ts:3–4 → server/boss 的 re-export | kernel 把 server 实现再暴露，方向与真实实现 owner 不一致 | 新增时继续由 kernel 反向门硬拦；不能借稳定契约分类免责。当前存量按原 base 规则 |

practice `learnableFrontier` 的 `.ids` 投影还拥有旧调用契约，
不把整个文件都说成无责任薄壳，也不借本提案删除它或相关测试。
上述分类不自动批准 `isMasteredForFrontier` 等其他符号；逐符号判断必要性。

## 两个维护场景

1. 修改 frontier 的溢出、掌握或排序决策：实现集中在 knowledge resolver，
   practice 不应知道 CTE、预算探针和排序步骤。把实现移入 public，
   或为过门添加假转换，没有减少调用方知识，反而破坏信息隐藏。
2. 新增另一个需要三态结果的消费者、同时逐步退出旧 practice 绑定：
   新消费者依赖同一稳定 knowledge 契约；旧绑定随旧 consumer 退出而退役。
   两者不同寿命，不能共用“14 天之后都删除”的结论。

## 建议裁定（推荐最小修正）

保留 AST 的逐符号事实采集、base 增量、依赖来源、数字/SCC/体积门、
kernel 反向硬门及现有兼容期限；**不按 public/index/port 名称免责**。

对新增转出站点区分三种裁决：

- 稳定公开契约：必须明确真实实现 owner、窄接口隐藏的完整事实/操作、
  解析后的目标符号、实际 consumer，以及独立审查的两个维护场景。
  由有权裁定者给可追溯批准，作者声明不是批准。若获批，不套兼容退役期限。
- 临时兼容：继续使用已批准的四条件和最长 14 天，不可改标稳定契约逃避退出。
- 冗余转发、反向 facade 或尚未分类：维持阻断。稳定契约裁决不能覆盖其他硬门。

如协调批准该语义，实施仍限两个既有 audit 和现有 baseline 数据。
建议复用现有变更登记增加**精确站点裁决**，绑定源码 revision/实现证据、
导出符号、解析目标及 consumer；不新建 registry 或 job，不做目录级白名单。
机器校验引用真实、站点匹配、依赖方向、记录适用范围和增量；
是否隐藏完整决策仍由独立判断承担。站点/目标身份变化必须重新裁定，
不能让旧记录覆盖新 alias、新符号或不同实现 owner。
具体记录字段与收紧条件须在裁定后给出最小 schema diff，不能先实施再追认。

这会改变当前“全部新增 re-export 只能走限期 compatShims”的硬失败范围，
所以必须回原协调/owner 授权链确认。若认为必须坚持该字面规则，
应明确它会拒绝上述已认可的稳定公开契约；父线不自行放宽。

## 完成证据与未运行范围

父线实际运行现有命令（经 heavy.sh，无新验证脚本/fixture）：
`pnpm audit:architecture-deepening --base 1440e864b7b4d7281dbb0612243f3c00b9e90ff3`，
即 #1837 的真实父提交；审计代码/被审 head 是 `c1253cb14`。
这是历史 base 到当前 head 的比较，**不是**精确重放 #1837 单一差量。
退出码 1，日志同时列出 knowledge 正式出口及 practice 旧兼容出口为必须限期的站点。

外置根：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1579/c1253cb14106ff66cfc6992fc4c65a6ad105c429/public-port-classification/`

- `frontier-public.diff` / `frontier-compat.diff`：真实 #1837 前后差量。
- `run.json`：审计 head、历史 base、命令、退出码及日志摘要。
- `real-history-frontier-audit.log`：
  SHA-256 `b20ef4cf2f4db1f62c56c0bf4393e6fd5e35de5e7cf35fb0c5a6e86a0bc3c759`。
- `frontier-findings.txt`：该真实运行中正例与兼容反例的站点输出。

裁定后最小验收：同一真实 frontier 站点可表达获批长期契约；
旧 practice 兼容口仍受原准入/期限约束；新增 kernel→server 不因分类获豁免；
新增 alias/变目标不能复用旧裁决；未分类默认失败。
没有真实获批登记样本时明确 NOT_RUN，不编造批准或写测试来演示。

目前未改 #1895 的 audit、baseline、产品或测试代码；未新增审查或 writer。
专门分类机制尚未实现/运行；DB/TEST/Docker/provider/runtime 全部 NOT_RUN。
合并单次唤醒已禁用，两小时进度任务保留。

---

## Appendix — coordinator rulings (appended 2026-10-21)

The proposal text above is verbatim; original SHA-256
`c89165fcb0265173fbaef102b78f34a9b883dbb5b40f26c93c0b1965875dcede`.
Per-site decisions and five-field source material:
`docs/planning/2026-10-21-frontier-port-site-decisions.md` (verbatim copy,
SHA-256 `fe5d7359053d2010e32c57260b0791f07b7140689fe3e1dbe873f8d36d7890b8`,
parent commit `30ffe7568`). Coordinator approval transcription:
https://linear.app/yukoval-studios/issue/YUK-1579#comment-af8190bd-7e93-4133-ba02-68a844f006fc
— the URL is a traceable pointer; authority rests on the coordinator thread
and the parent's verification, not on the URL's shape or author.

### Site 1 — `knowledge/public.ts` `learnableFrontierResolved` → STABLE CONTRACT

Approved stable. Recorded as a `stable_contract` entry in the existing
`capability-boundary-baseline.json` `changes` ledger with all five fields:
owner `knowledge`; target symbol `learnableFrontierResolved` in
`src/capabilities/knowledge/server/frontier-read.ts`; real consumer
`src/capabilities/practice/server/learnable-frontier.ts:5` (call sites
:26-27); source evidence `frontier-read.ts:220-352` at
`de061af07afece563d0f350a5e101a3e395c6c58`; rationale — knowledge hides the
closure query, overflow/sparse/dense, mastery gate and ordering behind the
port, so the export is a stable contract, not compatibility forwarding.
Scope: this exact symbol/target only — `isMasteredForFrontier`, other
aliases and the rest of `public.ts` are NOT covered. This is an existing
base site receiving provenance classification, not a new-site exemption.

### Site 2 — `practice/server/learnable-frontier.ts:9` same-name re-export → COMPAT (not stable)

Not a stable contract; no final runtime consumer was proven. It remains
un-punished base stock under the grandfather rule and receives NO new
compat approval, NO fabricated deadline. Retirement of this re-export and
the `practice/public` binding is a follow-up slice that must re-check
consumers against latest main. No product code or test is changed here.
