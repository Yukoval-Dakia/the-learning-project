# 完整输入规范化与 hash 归位（YUK-1570）

服务阶段：帮助靠谱；契约：任务输入、判分 provenance 与准入回执使用同一规范化/hash 算法。
本片是完整职责迁址与冗余转出退役，不是新的接口深化，也不完成整张架构票。

当前整合基准 `67506c5eaa5604ba34d2c943132343bf2e7fab5e`，五门源码提交
`0575996e798539762be3d3dd54e42ae6090fa4dd`；实际依赖总数 `393/0/37`，practiceAI 54。
原始迁址基准 `83bbecdaecaf70be0ae0241795fac3d5a07940c1`，初次源码提交
`32bda226435b50cd3391b0a1cdec68fd78bf64c4`；下文旧水位与旧 gate 为历史证据。
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
`0575996e798539762be3d3dd54e42ae6090fa4dd`。

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
   不减少 >1500 文件；数字、SCC 与 baseline 收紧需父线实测，不自行登记或改 audit。

## 初次交付证据与验证历史

外置根：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/32bda226435b50cd3391b0a1cdec68fd78bf64c4/`。
`task-input-hash-source/` 保存逐文件证明、raw diff、完整 caller census、argv/UTC/真实退出码；
`sha256.json` 的 SHA-256 为 `22ff757673b8c09c8e68154d1e851843207e330013a9296f2cd715eed166fe8b`。
`task-input-hash-exact-census/` 补充精确符号检索，排除另一算法的 substring 命中。
源码比较与 `git diff --check` 通过，没有执行产品算法来冒充 hash 输出实测。

父线已在原 `cb11d2d1` 对本树完成唯一一次 frozen install，rc0；安装日志 SHA-256
`7492901033cec2d6e7757bcb4ad30c55ee185cac0b19209e2db5ae8003497c89` 核验一致。
普通 merge main `20222f2cafe1500a9e445b43fe132935405d825a` 无冲突，产生 `ad65981c`；
上游三个 publication 路径与本片原有 blob 全保留，package/lock/workspace 与已装版本相同，未重装。
首轮 lint 因本片 `invoker.ts` import 被压成单行而失败；`18ddb1c3` 仅恢复其换行，
受保护正文和算法全文再次核对相同，不归因上游。首轮失败证据保留，未覆盖 seal。

在 `18ddb1c3b41f7549634c84d22694a3f0d8ec8892` 经外部 heavy.sh 串行重跑五门：
typecheck/lint/build rc0（lint 180 warnings）；两 audit 均显式 `--base 20222f2c`，rc1，
且各仅报两项预期收紧：`practice → ai 60 < 61`、`capability → server 402 < 403`。
该轮无其他新边/size 违规，baseline 尚未登记，rc1 原样封存。
原始 stdout/stderr、argv、UTC（含排队等待）、真实 rc 和逐文件证明封存在
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/18ddb1c3b41f7549634c84d22694a3f0d8ec8892/task-input-hash-five-gates/`；
`sha256.json` 的 SHA-256：`57abc3fe0d49f421917baf8ac66ba23018ffeb03fd64ae8eaab6c1f2eee9a353`。
原 `ad65981c` 五门及定向格式诊断仍在其 exact-head 的独立目录中。

父线随后明确授权仅用既有 `audit:capability-boundaries --tighten` 原生登记本片下降。
在 `96653c64` 经 heavy.sh 执行该命令 rc0，产生 baseline 提交
`ed6f272b2f666fca14f6f055685fc14756a8f6f4`：仅追加一条原生 UTC 日期的
`practice → ai 61→60` decrease，并收紧总数 `403→402`。
原 changes 18 条前缀、notes 30 项、edgeRecords 20 条、sourceSizeRecords 1 条、compatShims 7 条
全部原样保留；没有手造数字、改 audit 逻辑或预付尚未合入 JSON 片的下降。

在 `ed6f272b` 经 heavy.sh 串行运行 baseline Biome check、两 audit（`--base 20222f2c`），
三项均 rc0。实测依赖总数 `402/0/37`，SCC 仍为 `{agency, knowledge, practice}`，
new dependency edges=0、new pass-through sites=0；>1500 文件 13，与本次 base 相同。
源码未变，按授权不重跑 typecheck/build；保留先前 `18ddb1c3` 的真实通过结果。
raw stdout/stderr、argv、UTC、真实 rc 位于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/ed6f272b2f666fca14f6f055685fc14756a8f6f4/task-input-hash-tightened-audits/`；
`sha256.json` 的 SHA-256：`ede629a7d13d3a84381adb5e14d06214b22f3d77b8c9ac6fba2d566347777df5`。

## 已审片普通合入最新 main

父唯一 R1 对 `20222f2c→e1e49804f8ae956fb59af1010326c2f9e3c551cd` 给出 APPROVE，
新可达 P0/P1 为 0。已读取原报告并核 SHA-256
`c46c2ba1fedc4e9eda21f9160a6e17b210b003eac8b045e6f44737ed7afc3862`，
报告位于外置 `YUK-1570/e1e49804f8ae956fb59af1010326c2f9e3c551cd/review-r1-codex.md`。
本次未重开审查；以下是已审源码等价与重新执行五门的证据，不扩大原 R1 的静态裁决范围。

fetch 确认最新 main 为 `67506c5eaa5604ba34d2c943132343bf2e7fab5e`，普通 merge 得到
`473ac74b48874cdf4b0377d85ed821343e8f713c`。唯一冲突为 baseline 的三个真实 hunk：
旧本片 `61→60` 与 main 四条 JSON decrease、总数 402/394、practiceAI 60/55。
逐 hunk 采用 main incoming，解决后的 baseline 字节等于 main；没有覆盖产品文件。
本片 7 个存活产品文件及旧删除路径共 8 路径状态/blob 与 R1 源码相同，五 caller 保护正文逐字相同；
main 其余 16 个上游路径（含旧删除路径）全部保留。依赖三 hash 与父 install receipt 相同，未安装。

从 main 的 394/55 出发，官方 `--tighten --base 67506c5e` 实测后仅追加 `55→54`、总数 `394→393`，
提交为 `0575996e`；未预付数字。本片旧未合 `61→60` 账目不进入最终 HEAD，旧提交及 seal 留在历史。
main changes 22 条完整前缀与其中四条 JSON decrease 原样保留，最终仅 append 第 23 条；
notes 30、edgeRecords 20、sourceSizeRecords 1、compatShims 7 全部不变。

在 `0575996e798539762be3d3dd54e42ae6090fa4dd` 经 heavy.sh 全机 2 槽、本 lane 串行运行
typecheck/lint/build/两 audit，五项真实 rc0；lint 180 warnings，两 audit 显式 `--base 67506c5e`。
实测 `393/0/37`、practiceAI 54、SCC 1×`{agency, knowledge, practice}`、>1500 文件 13（base 13），
new dependency edges=0、new pass-through sites=0。未修改测试，无新的类型/格式或语义修复。
raw stdout/stderr、argv、UTC、真实 rc、逐 owned blob/body 及 main 前缀证明位于
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/0575996e798539762be3d3dd54e42ae6090fa4dd/task-input-hash-main675-five-gates/`；
`sha256.json` 的 SHA-256：`5153e4220537d8f896938ffad2ee892cfa10a5b39fb650c35b92779eedbb5bca`。

tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/CI、部署均 NOT_RUN。
audit 逻辑/schema/CI/package/lock 零修改；baseline 仅授权原生收紧与真实冲突整合。
父负责后续 PR/CI 与 issue 状态；本 writer 未自派审查。
本片未发现需新增 tracker 的独立缺陷，也未自行调用 Linear。
