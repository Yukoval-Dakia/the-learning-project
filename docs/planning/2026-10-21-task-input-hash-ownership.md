# 完整输入规范化与 hash 归位（YUK-1570）

服务阶段：帮助靠谱；契约：任务输入、判分 provenance 与准入回执使用同一规范化/hash 算法。
本片是完整职责迁址与冗余转出退役，不是新的接口深化，也不完成整张架构票。

当前整合基准 `f52a41bb2b8453a3cce8907e805327e20d821934`，五门源码提交
`b3b878d1a157c70f4da3fd565f4f8b8ecbafac55`；实际依赖总数 `393/0/37`，practiceAI 54。
原始迁址基准 `83bbecdaecaf70be0ae0241795fac3d5a07940c1`，初次源码提交
`32bda226435b50cd3391b0a1cdec68fd78bf64c4`；先前 gate、失败及整合记录均留在原 exact-head seal 中。
父线逐路径确认六处 import/export hunk 后实施；没有带入父树旧 docs。

## 完整 owner 与调用方

`src/core/task-input-hash.ts` 完整接管原 `src/server/ai/task-input-hash.ts` 的
93 行、4,363 字节；Git 判定 R100，全文 SHA-256：
`8c40eed31521aafeef4bd636b359f1e17df1263adccce5065c99072dad0129c3`。
私有 `CANON_MARKER`、`bytesEnvelope` 与三个原有函数一起迁移，旧真身删除。
唯一依赖仍是 `node:crypto`，不能据 core 目录声称浏览器可用。
`core/migration/canonical.ts` 是已有 Node 纯算法位置先例；本片不混并语义不同的
`kernel/canonical-json.ts`。没有新 adapter、registry、stable/compat 转发或假逻辑。

下表路径除首项外均相对 `src/capabilities/practice/server/`；行号对应校验源码
`b3b878d1a157c70f4da3fd565f4f8b8ecbafac55`。

| 真实 caller | 直接绑定与调用位置 | 原有调用方知识/策略 |
| --- | --- | --- |
| `src/server/ai/run-lifecycle.ts` | `taskInputHash`，171/173 | `safeInputHash` 的 catch/String 回退 |
| `judge/judge-execution-provenance.ts` | `sha256Canonical`/`stableCanonicalValue`，15/27 | prompt/version/system/user envelope |
| `judge/invoker.ts` | `taskInputHash`/`sha256Canonical`，273/322 | metadata guard 与 result digest |
| `judge/execution-provenance-resolve.ts` | `sha256Canonical`，202 | deterministic provenance |
| `admission/solve.ts` | `taskInputHash`，178 | sealed receipt 的 input equality |

五个 caller 均直接 import 唯一 core owner；上述策略与函数正文保持原样。
`judge-execution-provenance.ts` 原三个 hash 转出及 `judge/index.ts` 原两个 hash 转出删除；
后者没有真实 hash consumer，仍保留 `JUDGE_PROMPT_TEMPLATE_REVISION`。
全仓 tracked/hidden 字面量检索与迁移前 LSP 引用交叉核对，没有测试或配置直接钉住旧路径/三符号。
历史设计文档的函数名与 yuk1393 seal 的 dist 文件名原样保留；
`sha256CanonicalJson` 是另一算法，不计入本族。测试代码零改动。

## 两个真实维护场景与五项标准

1. 完整事实与 owner：URL、Uint8Array、Date、BigInt、原有 exotic/function/symbol 拒绝、
   marker escape、数组/对象顺序、JSON fallback、错误抛出、分配对象及 SHA 构造均为逐字源码迁移。
2. 改 bytes envelope 版本/摘要表示时，迁前改旧算法一处，迁后改新算法一处；
   持久 hash、prompt fingerprint 与准入回执的兼容义务均保留。本片不改变任何 hash 字节规则。
   改 advisory lifecycle 的拒绝回退时，迁前后都只改 `safeInputHash`；
   judge fail-closed 与准入回执策略仍各归原 caller，算法不新增共享回退。
3. 两场景的编辑点数均未减少，调用方原本已经不必理解递归实现；不声称新隐藏了中间态或顺序。
   变化是跨科目纯算法归属与直接依赖，退出 judge 的冗余 hash 转发。
4. 模块不拥有事务、锁、队列、provider 或持久状态。逐文件证明五 caller 首个声明到 EOF
   字节相同，index 全文件仅获准转出删除；paid/预算/typed-submit/frozen/claim/publish/revoke 正文零改。
   所有调用指向同一模块 binding，无新 wrapper/cache；对象与错误路径的源码保真不等于运行实测。
5. 风险集中在持久 hash 表示和 caller 拒绝策略，因此仅迁址，未改这些行为。
   不减少 >1500 文件；数字与 SCC 仅报实测；baseline 仅依父授权用原生 tighten 登记，不改 audit。

## 当前整合、R1 与验证

父唯一 R1 对 `20222f2c→e1e49804f8ae956fb59af1010326c2f9e3c551cd` 给出 APPROVE，
新可达 P0/P1 为 0；原报告 SHA-256
`c46c2ba1fedc4e9eda21f9160a6e17b210b003eac8b045e6f44737ed7afc3862` 已核验。
报告位于外置 `YUK-1570/e1e49804f8ae956fb59af1010326c2f9e3c551cd/review-r1-codex.md`。
本次未重开审查；本片 7 个存活产品文件及旧删除路径共 8 路径状态/blob 与原 R1 相同，
五 caller 保护正文逐字相同。这是已审源码等价与重新执行五门的证据，不扩大原 R1 静态裁决范围。

fetch 实际 main 为 `f52a41bb2b8453a3cce8907e805327e20d821934`；普通 merge 得到
`6d14432a4b66eb63055aec072be49a4e0739adc4`，无 rebase/force。
唯一冲突为 baseline 中本片 `55→54` 与 main 新增 11 条 schema stable 的同一追加 hunk。
采用 main incoming，并将 Git 自动保留的本片计数恢复为 main 底账，解决后的 baseline 字节等于 main。
main 全部其余路径/blob/删除状态均保留；未覆盖 SOURCE/PI/schema/settle 或其他上游产品修改。
依赖三 hash 与父唯一 install receipt 相同，本轮没有 install/update/复制依赖。

从 main `394/55` 出发，heavy.sh 官方 `audit:capability-boundaries --tighten --base f52a41bb`
实际 rc0，仅追加 `practice → ai 55→54`，总数 `394→393`，提交为 `b3b878d1`。
main changes 33 条完整前缀保留，最终只 append 第 34 条；不回带过期 `61→60`。
main 本轮新增的 11 条 schema stable、既有 1 条 frontier stable（合计 12）全部字段精确保留；
notes 30、edgeRecords 20、sourceSizeRecords 1、compatShims 7 全部不变。
没有新增 stable/compat，也未修改审计/schema 逻辑、ignore 或 registry；无需原 record 行号修复。

在 `b3b878d1a157c70f4da3fd565f4f8b8ecbafac55` 经 heavy.sh、`HEAVY_SLOTS=2`、本 lane 串行执行
typecheck/lint/build/两 audit，五项真实 rc0；lint 180 warnings，两 audit 显式 `--base f52a41bb`。
实测依赖 `393/0/37`、practiceAI 54、SCC 1×`{agency, knowledge, practice}`，
>1500 文件 12（base 12），new dependency edges=0、new pass-through sites=0；不计上游超长变化为本片收益。
raw stdout/stderr、argv、UTC、真实 rc、逐 owned blob/body 与 main 账目前缀证明位于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/b3b878d1a157c70f4da3fd565f4f8b8ecbafac55/task-input-hash-mainf52-five-gates/`；
`sha256.json` 的 SHA-256：`a6a215d09966ca3fe90ead4a476d68e33fa20ca990270cfb8d5072df78c483cd`。
原始算法证据仍为 `YUK-1570/32bda226435b50cd3391b0a1cdec68fd78bf64c4/task-input-hash-source/`，
其清单 SHA-256 为 `22ff757673b8c09c8e68154d1e851843207e330013a9296f2cd715eed166fe8b`；旧 seal 未覆盖。

tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/CI、部署均 NOT_RUN；测试零修改。
本轮仅普通整合、原生 ledger 登记及本交付文档更新，无语义修复或自派审查。
父统一负责后续验收发布与 issue 状态；未发现需新增 tracker 的独立缺陷，未调用 Linear。
