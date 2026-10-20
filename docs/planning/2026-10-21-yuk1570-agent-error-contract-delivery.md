# 运行失败契约归位（YUK-1570）

完整共享契约与两个 server 适配已接线；零 shim、零新转出/白名单。
当前整合基点 `f52a41bb2b8453a3cce8907e805327e20d821934`；已审前序 final
`2d86d6463b5363badfeaf5cc4c06066424b0d343`。
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

## 全部直接消费者（src/ 下，当前 import 行号）

| 文件 | import 行 | 实际使用 |
|---|---:|---|
| server/ai/runner.ts | 27、42 | SDK failure 构造、retry deadline；bind/isApi 仍由 server 适配 |
| server/ai/typed-primitive-runner.ts | 33、38 | typed failure/permanent 判别；bind 仍由 server 适配 |
| server/ai/run-lifecycle.ts | 2–6 | wall-clock 构造、失败终态和 retry |
| server/ai/agent-run-error.ts | 4 | admission binder 复用唯一共享 class |
| server/ai/provenance.ts | 1 | isGenerationBudgetTimeout |
| server/assessment/jev-model-executor.ts | 11 | instanceof 支出/重试判别 |
| server/assessment/pi-model-executor.ts | 2 | 已知成本、失败 run refs |
| server/assessment/rubric-model-executor.ts | 12 | run refs、timeout cost/预算错误 |
| server/grounding-gate/intervention-review-eval.ts | 3 | 失败 durable run identity 对账 |
| capabilities/ingestion/server/agent/run.ts | 3–7 | budget_exhausted/model_unavailable 分类 |
| capabilities/practice/server/intervention-author.ts | 1 | 两处 validator failure run refs |
| capabilities/practice/server/judge/provider-lane-fallback.ts | 4 | 仅 API failure 的 lane 判别 |
| capabilities/practice/server/quiz/verify-framework.ts | 2 | solver paid run refs、unsupported/permanent |
| server/assessment/rubric-model-executor.test.ts | 2 | 同一 AgentRunError constructor；唯一获批测试 import |

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
f52a41b 的完整 33 条账本为底，原生实测仅追加 ingestion AI 16→15、practice AI 55→52，
总数 394→390；main 33 条 changes 的逻辑与原始字节前缀均相同，旧未合 61→58 记录不携入。


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
本轮 fetch 实际 main 为上述 f52a41b（SOURCE/PI/schema/settle），普通 merge 后源码提交
`4be07a36ca32aca7de715c598889d1cdd9aff487`，未 rebase/force、未另开审查。
仅 baseline 冲突；以 main 全账本为底，原生 tighten 生成本片两条下降。
前序 67506c5 整合的 intervention-author / verify-framework 仅 import 并集保持原样，
本轮未再改产品行；main core JSON 与 ERROR shared import 全部保留。

14 产品整 blob 同前序已审 final 2d86d646；14 个非 import 正文同 R1 6a6655cf，
其中 12 整 blob 同 R1，另两处仅前序已准 core JSON import 归位。12 消费者 main import
binding 并集完整；main 其余 4456 个路径的 mode/type/OID 全同，无上游删除状态反转。
批准测试全文同 R1、import 仍在第 2 行，删除该行后同原 83bb 基点；用例/数据/断言不动。
单一 class、fields、错误、unknown cost、SDK/admission 与全部 paid body 保持；此等价证明
不冒称对上游 SOURCE/PI/schema/settle 语义另做过 R1。

按父最新澄清执行既有 append-only / tail-only：main 已合的 11 条 schema stable record
原始 entry 字节全同，含历史 consumer.line；未追加 stable/compat、未挪产品行、未改 gate。
当前 AST 有 12 处 consumer 行号位置差异，binding 身份不变，只封存仓外事实。
已核 audit-architecture-deepening.ts:1446–1451 仅取基点 changes 后的 tail，
pass-through-sites.ts:991 仅核传入 stableRulings；本片 tail 无新 stable，实际审计结果见下。

## 验证与待决

外置根 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/`。
原候选、原失败及前序 2c1233c / 2d86d646 seal 全保留，不覆盖；本轮 exact 源码封存在
`4be07a36ca32aca7de715c598889d1cdd9aff487/agent-error/main-refresh/`。
该目录含源码 tar/tree、冲突、原生 tighten、raw stdout/stderr、argv、UTC、真实返回码、
依赖及 caller/class census。证明文件（相对该目录）：
`premerge-evidence/source-identity-proof.json` SHA256
`a81568d86f1fc90e658c944749c113c55088f224b04e06e28fe1b5f77198f96e`；
`premerge-evidence/ledger-identity-proof.json` SHA256
`9b6dfcc7f35cfe8f5b2df8823a3e9d16e9ffdfc3e04f82d8fb2fa8699c171587`。

静态字节对照与 git diff --check 已完成。依赖三 hash 同父唯一一次 frozen install 回执，
本 writer 未 install。新 exact 源码 4be07a36 的 typecheck（两 tsconfig）/lint/build/两 audit
均通过 exit 0；全部经外部 heavy.sh、HEAVY_SLOTS=2，本 lane 串行；lint 180 warnings。
两 audit 均固定 `--base f52a41bb2b8453a3cce8907e805327e20d821934`，未改用旧基点。
实测 server 394→390（ingestion AI 16→15、practice AI 55→52）、deep 0、cross 37、
SCC 1、>1500 文件 12（base 12），本片无超长减少。
main 全 33 条 changes 的逻辑与原始 entry 字节前缀相同，现共 35 条，仅追加授权两下降；
除总数及两个 owner pair 外，其余 baseline 全字段同 main。11 历史 stable 未触及，
真实 tail-only audit 未报历史 consumer stale。audit/schema/ignore/registry 无本片改动。
后续只提交本交付文档，最终 source/ledger 对该已验证提交的等价证明另封
`<final-head>/agent-error/final-main-refresh/`。

所有本机 tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/自派审、
Linear/清树均 NOT_RUN。无新范围外 actionable follow-up；父 PR/exact-head CI 统一处理。
