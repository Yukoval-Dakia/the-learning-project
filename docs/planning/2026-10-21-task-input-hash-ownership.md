# 完整输入规范化与 hash 归位（YUK-1570）

服务阶段：帮助靠谱；契约：任务输入、判分 provenance 与准入回执使用同一规范化/hash 算法。
本片是完整职责迁址与冗余转出退役，不是新的接口深化，也不完成整张架构票。

基准 `83bbecdaecaf70be0ae0241795fac3d5a07940c1`，源码提交
`32bda226435b50cd3391b0a1cdec68fd78bf64c4`。
父线逐路径确认六处 import/export hunk 后实施；没有带入父树旧 docs。

## 完整 owner 与调用方

`src/core/task-input-hash.ts` 完整接管原 `src/server/ai/task-input-hash.ts` 的
93 行、4,363 字节；Git 判定 R100，全文 SHA-256：
`8c40eed31521aafeef4bd636b359f1e17df1263adccce5065c99072dad0129c3`。
私有 `CANON_MARKER`、`bytesEnvelope` 与三个原有函数一起迁移，旧真身删除。
唯一依赖仍是 `node:crypto`，不能据 core 目录声称浏览器可用。
`core/migration/canonical.ts` 是已有 Node 纯算法位置先例；本片不混并语义不同的
`kernel/canonical-json.ts`。没有新 adapter、registry、stable/compat 转发或假逻辑。

下表路径除首项外均相对 `src/capabilities/practice/server/`；行号对应源码提交。

| 真实 caller | 直接绑定与调用位置 | 原有调用方知识/策略 |
| --- | --- | --- |
| `src/server/ai/run-lifecycle.ts` | `taskInputHash`，171/173 | `safeInputHash` 的 catch/String 回退 |
| `judge/judge-execution-provenance.ts` | `sha256Canonical`/`stableCanonicalValue`，15/27 | prompt/version/system/user envelope |
| `judge/invoker.ts` | `taskInputHash`/`sha256Canonical`，270/319 | metadata guard 与 result digest |
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

## 源码证据与验证边界

外置根：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/32bda226435b50cd3391b0a1cdec68fd78bf64c4/`。
`task-input-hash-source/` 保存逐文件证明、raw diff、完整 caller census、argv/UTC/真实退出码；
`sha256.json` 的 SHA-256 为 `22ff757673b8c09c8e68154d1e851843207e330013a9296f2cd715eed166fe8b`。
`task-input-hash-exact-census/` 补充精确符号检索，排除另一算法的 substring 命中。
源码比较与 `git diff --check` 通过，没有执行产品算法来冒充 hash 输出实测。

本树缺依赖，已向父线唯一请求一次 frozen install，未自行 install/update/复制 node_modules。
typecheck/lint/build/两 audit 当前 NOT_RUN；依赖就绪后的五门须经外部 heavy.sh 串行封存。
tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、独立 review、push/PR/CI、部署均 NOT_RUN。
audit/schema/CI/package/lock/baseline 零修改。后续验证、集成、issue 状态与审查归父线；
本片未发现需新增 tracker 的独立缺陷，也未自行调用 Linear。
