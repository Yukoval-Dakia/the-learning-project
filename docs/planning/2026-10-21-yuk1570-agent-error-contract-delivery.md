# 运行失败契约归位（YUK-1570）

完整共享契约与两个 server 适配已接线；零 shim、零新转出/白名单。
基点 `83bbecdaecaf70be0ae0241795fac3d5a07940c1`，分支
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

已按该范围仅改测试第 12 行路径，其余字节原样；旧 AgentRunError 转出删除。
此前 compat 仅是未提交候选，未自批/登记，最终无 stable/compat 待决。

## 两个维护场景与五项标准

1. 修改共享错误字段/冻结 taxonomy：原先已封装为一处，归位后仍只改 shared contract。
   SDK/admission 适配不跟随位置变化；调用方仍须理解 fields/subtype/unknown cost/instanceof，
   接口知识未减少，不把纯归位称为新算法深化。
2. 修改 admission 绑定或 SDK success+is_error 适配：仅 server 适配变化，12 个产品消费者
   不再因错误契约继承 admission/DB/catalog 依赖。当前不实际改变这些规则。

五标准：完整责任 owner 明确；两个场景明确修改位置；诚实区分传递依赖退出与接口知识未减；
身份/成本/顺序/既有生命周期协议保留且 source/runtime 证据分层；按真实 consumer、占用及批准
实施，数字不替代语义。四条 capability→server 边迁出仅为待官方审计假设，不预付收益。

## 验证与待决

外置根 `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1570/`。
基点 `/83bbecdaecaf70be0ae0241795fac3d5a07940c1/agent-error/` 下保留各次准备 seal：
`candidate-20261020T222116Z/sha256.json` SHA256
`b23b1f8c844efdc6f1a1c7d50344d8d7ffd0a36a6fb27809f3e5d8706742acf5`（此前待裁候选，非最终验收）。
最终 exact HEAD 的源码/原始命令/逐文件 hash 另落 `<final-head>/agent-error/final-source-proof/`，不覆盖旧 seal。

静态字节对照与 git diff --check 已完成；13 个既有改动 TS 的 node --check exit 0。
新共享 TS 在原样迁入的 private type 处被 Node --check 报 Unexpected identifier；显式模式也 exit 1，
失败原样留在基点 syntax-* 目录，不冒称类型检查通过，待真实 tsc 验证。

缺 node_modules，未 install/update/复制依赖。typecheck/lint/build/两 audit 均 NOT_RUN，
交父串行一次 frozen install 并仅经 heavy.sh 验证；baseline 实测差异由父登记。
本机 tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/watch/review、
Linear/清树均 NOT_RUN。无新范围外 actionable follow-up；父负责 tracker、基线和最终 gate。
