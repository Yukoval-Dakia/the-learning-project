# 运行失败契约归位（YUK-1570）

完整共享契约与两个 server 适配已接线；零 shim、零新转出/白名单。
当前整合基点 `67506c5eaa5604ba34d2c943132343bf2e7fab5e`。
原实现基点 `83bbecdaecaf70be0ae0241795fac3d5a07940c1`，分支
`arch/yuk-1570-agent-error-contract`，独立树 `t3-91f03c31`。
先 fetch 后从最新 origin/main 建分支，未带 T3 父起点 c338877f8 的旧文档提交。
本片服务已授权架构深化，不宣称学习者行为或阶段验收变化。

## 职责和保护

原 server 文件:26 真实 value import `ProviderSessionAdmissionError`，其依赖 DB/config/providers，
不能将整文件伪称纯算法。新 `src/ai/agent-run-error.ts` 拥有完整 subtype/fields、两个 Error class、
wall-clock message/身份判别、10,000ms cap 和冻结重试白名单，零 import。
原 server 文件仅留完整 admission binder 与 SDK success+is_error 形状适配。

- class 各只有一个定义，message/name/全部字段、errors 原数组引用不变。
  wall-clock class 独立继承 Error，仍仅 instanceof 识别。
- binder 先判已有 AgentRunError，cost 未传返回原对象，传入才按原规则克隆；
  admission 分支仍先于 aborted，仍不附加 input.costUsd；未知成本不补零。
- transient 仅认 AgentRunError：stream_no_terminal，API null/undefined/429/500..599 为 true，
  其他全部 false；elapsed 比较仍 `< 10_000`。SDK predicate 仍严格 success + is_error===true。
- 两段共享声明/判别和两段 server 适配从基点逐字迁移；12 产品消费者非 import 字节全同。
  provider-session-admission.ts、paid/unknown、预算、typed-submit、frozen、claim-fence、
  发布/撤销、恢复、参数及执行顺序不动。仅 scope 内 import 拆分。

## 全部直接消费者（src/ 下，原基点行号）

| 文件 | import 行 | 实际使用 |
|---|---:|---|
| server/ai/runner.ts | 41–46 | SDK failure 构造、retry deadline；bind/isApi 仍由 server 适配 |
| server/ai/typed-primitive-runner.ts | 37–42 | typed failure/permanent 判别；bind 仍由 server 适配 |
| server/ai/run-lifecycle.ts | 6–10 | wall-clock 构造、失败终态和 retry |
| server/ai/provenance.ts | 6 | isGenerationBudgetTimeout |
| server/assessment/jev-model-executor.ts | 21 | instanceof 支出/重试判别 |
| server/assessment/pi-model-executor.ts | 12 | 已知成本、失败 run refs |
| server/assessment/rubric-model-executor.ts | 27 | run refs、timeout cost/预算错误 |
| server/grounding-gate/intervention-review-eval.ts | 16 | 失败 durable run identity 对账 |
| capabilities/ingestion/server/agent/run.ts | 12–16 | budget_exhausted/model_unavailable 分类 |
| capabilities/practice/server/intervention-author.ts | 39 | 两处 validator failure run refs |
| capabilities/practice/server/judge/provider-lane-fallback.ts | 6 | 仅 API failure 的 lane 判别 |
| capabilities/practice/server/quiz/verify-framework.ts | 42 | solver paid run refs、unsupported/permanent |
| server/assessment/rubric-model-executor.test.ts | 12 | 同一 AgentRunError constructor；唯一获批测试 import |

非 import 观察者：practice/server/solve-session.ts:369/372 按 name/subtype 分类；
notes/jobs/note_generate.ts:115 经 provenance 间接识别预算错误，两者不动。
runner.fallback.test.ts 经 runner 钉 null connection shape 与 durable judge 不得 lifecycle retry，不改不跑。

## 零 shim 的明确批准

父转达协调最新裁定原话（2026-10-21，沿 owner 10-19 授权）：

> 协调最新明确裁定已到：选零shim。唯一测试改动src/server/assessment/rubric-model-executor.test.ts:12 AgentRunError从@/server/ai/agent-run-error改到@/ai/agent-run-error，同名同class，用例/数据/断言/:89–97构造全不动，只这一行，不排序/格式其他行，测试运行仍禁。旧server的AgentRunError转出同时删，绝不登记compat。属owner10-19授权协调直接批的清单类测试更改；交付doc引用本条批准原话，PR父引用。

初次按该范围仅改测试第 12 行路径，其余字节原样；旧 AgentRunError 转出删除。
此前 compat 仅是未提交候选，未自批/登记，最终无 stable/compat 待决。

追加明确批准（本父线程，2026-10-21）：

> 协调最新明确批准已到（本父线程）：同意 proposed-test-import-sort.diff SHA db178d52dbc6bde5f5bff08f3422e12bf1e9f86d720a12ffbb8585ec2d40cb65，把同一 AgentRunError import 从12移至2，除该行外全文逐字节一致；测试运行范围不扩大。

> 另父授权仅原生 heavy.sh pnpm audit:capability-boundaries --tighten 登记 ingestion→ai16→15/practice→ai61→58/total403→399（以官方真实输出为准），保留所有main账目前缀，不改audit/schema/ignore。

已在 9576999e55a5156c418f57e79f7d412055b151bf 核准 patch SHA 后精确应用；
测试现 import 位于第 2 行，删除这一个 import 后全文与 9576999 逐字节相同。
与最初 83bb 基点分别删除旧/新路径 import 后，全文亦逐字节相同；case/数据/断言/构造不动。
此前在历史 main 20222f2 上按该批准原生收紧的记录已保留原 seal。当前整合以最新 main
67506c5 的完整 22 条账本为底，原生实测仅追加 ingestion AI 16→15、practice AI 55→52，
总数 394→390；main 22 条 changes 的逻辑与原始字节前缀均相同，旧未合 61→58 记录不携入。


## 两个维护场景与五项标准

1. 修改共享错误字段/冻结 taxonomy：原先已封装为一处，归位后仍只改 shared contract。
   SDK/admission 适配不跟随位置变化；调用方仍须理解 fields/subtype/unknown cost/instanceof，
   接口知识未减少，不把纯归位称为新算法深化。
2. 修改 admission 绑定或 SDK success+is_error 适配：仅 server 适配变化，12 个产品消费者
   不再因错误契约继承 admission/DB/catalog 依赖。当前不实际改变这些规则。

五标准：完整责任 owner 明确；两个场景明确修改位置；诚实区分传递依赖退出与接口知识未减；
身份/成本/顺序/既有生命周期协议保留且 source/runtime 证据分层；按真实 consumer、占用及批准
实施，数字不替代语义。四条 capability→server 依赖退出已由官方审计确认，尚不计为 main 合并收益。

## 已审源码与 main 整合

父已报告唯一 R1 APPROVE；已审原源码 `6a6655cf0377e0f7ba612e4b8950bf45b5311a23`。
本轮 fetch 得到上述最新 main，普通 merge 后源码提交
`2c1233c18972717e068eb29537d157c5cfd10b09`，未 rebase/force、未另开审查。
仅 baseline 与 intervention-author / verify-framework 两处相邻旧 import 块冲突：
产品只处理各五行冲突 hunk，保留 main core JSON 与 ERROR shared import 并集；
baseline 从 main 全账本重建再原生 tighten，不用旧分支计数覆盖 main。

静态 AST/字节证明：14 产品非 import 正文同 R1，其中 12 个整 blob 相同、两处仅获准 import
owner 映射；所有 main import binding 保留，其余 14 个 main owned 路径的 blob/删除状态保持。
批准测试全文同 R1；单一 class、fields、错误、unknown cost、SDK/admission 适配及所有 paid body
不变。source 等价说明只覆盖这些实际差量，不冒称对上游 JSON 内容重新做过 R1。

## 验证与待决

外置根 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/`。
基点 `/83bbecdaecaf70be0ae0241795fac3d5a07940c1/agent-error/` 下保留各次准备 seal：
`candidate-20261020T222116Z/sha256.json` SHA256
`b23b1f8c844efdc6f1a1c7d50344d8d7ffd0a36a6fb27809f3e5d8706742acf5`（此前待裁候选，非最终验收）。
最终 exact HEAD 的源码/原始命令/逐文件 hash 另落 `<final-head>/agent-error/final-source-proof/`，不覆盖旧 seal。

静态字节对照与 git diff --check 已完成。依赖三 hash 与父唯一一次 frozen install 回执相同，
本 writer 未 install。新 exact 源码 2c1233c 的 typecheck（两 tsconfig）/lint/build/两 audit
均通过 exit 0，全部由外部 heavy.sh 全机最多两槽、本 lane 串行运行；lint 180 warnings。
两 audit 固定 `--base 67506c5eaa5604ba34d2c943132343bf2e7fab5e`。
实测 server 394→390（ingestion AI 16→15、practice AI 55→52）、deep 0、cross 37、
SCC 1、>1500 文件 13（base 13），本片无超长减少。

本轮 raw stdout/stderr、argv、UTC、真实返回码、冲突及逐 owned/body/账本前缀证明在：
`2c1233c18972717e068eb29537d157c5cfd10b09/agent-error/main-integration/`。
`premerge-source-proof/r1-main-source-proof.json` SHA256
`1c789ce74344ebf314b3857fffee6194092fca32a1f77b4133acc12445e78963`；
`premerge-source-proof/main-ledger-prefix-proof.json` SHA256
`23da7611ecb8a4efeea761cb08f040ebc1eb70f7c4d34a852a44c113b51af6a5`。
所有 main 账目字段保留，仅授权的两条追加和三个数值下降；audit/schema/ignore 未改。
此前 Node 解析及 lint/baseline 失败原 seal 保留，最新真实 tsc/五门结论不复用旧检查。

所有本机 tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/自派审、
Linear/清树均 NOT_RUN。无新范围外 actionable follow-up；父 PR/exact-head CI 统一处理。
