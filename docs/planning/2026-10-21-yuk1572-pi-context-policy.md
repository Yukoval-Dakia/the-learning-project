# Pi 上下文容量与历史保留策略（YUK-1572 / YUK-1570）

本片服务「帮助靠谱」的架构职责局部化。独立树
`/Users/yuqi/.t3/worktrees/the-learning-project/t3-0614f018`，分支
`arch/yuk-1572-pi-context-decisions`。起点旧 `c338877f` 经 `git fetch origin`
核得 `HEAD..origin/main=38`，从最新
`83bbecdaecaf70be0ae0241795fac3d5a07940c1` 新切，不带父旧 docs。
源码提交 `a6d85a17a280dd7c8c1022f194c31093ebac6a1e`，tree
`653ecba86477c4dfefc4d7279363d22379c7ad4e`；本文随后单独提交。

## 职责与授权

父核主线逐 hunk 占用后，明确允许原 `pi-agent-adapter.ts` 的估算、
`makeTransformContext` 算法及 `convertToLlm` 纯 role 过滤迁入内部模块。
只改该产品文件，新增同 family `pi-context-policy.ts`；无 re-export、
stable/compat、新 registry 或白名单。未改 audit/schema/CI/package/lock/baseline、
测试、PLAN 或其他树；全局状态和后续门由父线收口。

新模块 114 行，3 个同 family 入口，唯一 importer 是 adapter：

- `estimatePiTokens`：完整保留 text/thinking/tool arguments、system sections/
  toolsAdded 的序列化及 CJK/非 CJK 估算。只用于容量，从未用于 billing。
- `createPiLlmMessageConverter`：每次 config 创建新的过滤闭包，保留
  system/user/assistant/toolResult 的原消息引用，不共享旧 fresh callback。
- `createPiContextCompactionPolicy`：捕获 `min(contextWindow,maxInputTokens)`、
  85% trigger / 60% target（最低 1），返回本次触发计划；计划完整选择
  system prefix、最新历史、超预算仍配齐的 toolResult/call、sessionContext 去重。

两阶段接口保留原时序：估算及 trigger → `Date.now()` → awaited dynamic
import → `getCurrentSystemMessage` → history.filter → 原
`piUserMessage(sessionContext)` → prefix/历史预算与去重 → postTokens →
`Date.now()` duration → frame UUID → emitFrame。新模块无 clock/value import；
但 select 执行传入的 message factory，**不称该 callback 或整个 select 为纯函数**。
system helper 的输出直接使用，保留历史对象引用与 fresh session 消息的构造点。
未触发与失败仍返回同一个原 messages 数组；异常仍由原 catch/warn 处理。

## Caller 完整清单

新模块的唯一直接 caller：`PiPreparedQuery`。

- `makeTransformContext` 创建 policy、判触发并消费完整选择；原动态 import、
  clock、frame、catch/warn/fallback 留在 adapter。
- `makeTransformContext` 的 postTokens 及 `streamFn` 的 inputTokens 调用同一
  estimator；streamFn 原容量限制、maxTokens、onPayload 拒绝位置与后续正文未改。
- `baseLoopConfig` 消费 fresh converter factory，原 root 与 nested loop 两处
  baseLoopConfig 调用不变；没有新增 nested compaction。

adapter 原 8 个导出全部保留。外部 importers 共 6 个文件，均零修改：
`src/server/ai/execution-adapter.ts`（PiAgentAdapter）、
`src/server/config/admin-config-facts.ts`（piMaxRetries）、
`tests/dbos-judge/worker.ts`（PiAgentAdapter）、
`src/server/ai/pi-agent-adapter.tracing.test.ts`（PiAgentAdapter）、
`src/capabilities/practice/server/judge/judge-paid-retry.unit.test.ts`（PiAgentAdapter）、
`src/capabilities/copilot/jobs/copilot_run.streaming.db.test.ts`
（PiAgentAdapter/PiAdapterDeps）。测试只读取引用，未改未跑。
`src/capabilities/observability/server/config-read-model.ts` 的旧 source-path 标签不变。

## 两个真实维护场景与五标准

1. CJK 估算或 system sections/tool declarations 的容量计数变化：前后都只需改
   一处 estimator；本片没有新增多 caller 收益。变化是规则与完整历史保留策略
   同处独立模块，不再与 transport/paid 编排共文件审读。provider 的拒绝与输出
   headroom 决策仍属 adapter，未声称完整迁出所有 provider 容量策略。
2. 历史尾部的 tool call/result 配对或 sessionContext 替换规则变化：前后规则
   编辑点均为一个文件；现在由 policy 完整拥有，adapter 不再展开预算循环和
   role/session 匹配。system delta 重放、message 创建时点、错误回退与 frame
   仍是 caller 的时序知识；root config caller 过去就不知这些算法，接口知识未减少。

五标准对账：①限定的 token/历史表示/保留事实只有 policy owner，provider/session/
paid owner 不变；②三个内部入口承载真实实现，无转发壳；③两场景的编辑点数
不变，收敛的是审读范围及 class 内策略知识，不冒称新算法深化；④事务、锁序、
claim-fence、unknown/cost 恢复不属于本片，全部原样；⑤按职责及已核写权切，
adapter **2121 → 2044，仍 >1500**，新模块 114，不为尺寸扩大范围。

## 逐文件保护与证据

`pi-agent-adapter.ts`：静态逆向恢复获准替换后，全文件与 base 逐字相等；
估算/constants 原文一致（仅 estimator 增内部 export）；选择体只将原
piUserMessage 绑定换成传入 factory、最终局部赋值换成 return；predicate/
role filter 仅缩进不同。所有 clock 调用表达式与源码顺序一致。
`EMPTY_PI_USAGE` + replay、user/SDK 消息构造、providerTransport、structured
submit/streamFn 直到文件结尾各段逐字相等，保留错误/usage/class/message identity。

`pi-context-policy.ts`：只有 type imports；CJK 正则、计数序列化、85/60、
逆序预算循环、toolResult 配对及 session 判定原样归位。新导出均有上述真实
consumer；无独立 runtime consumer 扩面，无测试或付费入口。

源码 seal：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/a6d85a17a280dd7c8c1022f194c31093ebac6a1e/pi-context-policy-v2/`。
`sha256.json` SHA256 `ad005c86395a64b287c51b4fd25425edda0b2991dd5f3b574770c770400a568a`；
`source-comparison.stdout` SHA256
`38aa2a78608b60a7cd48febadfb76323e780a42c826ae26e7f60b74d2ea91389`。
每条命令 raw stdout/stderr、argv、UTC、真实 returncode 在各 `*.run.json`。
首轮 seal 保留：其 session-id 比较范围误含已迁 estimator；v2 只纠正比较范围，
产品源码没有为该证据修正而变化。

实跑：两文件 `node --check`、`git diff --check` 均 rc0；静态源码比较及 caller
清单已逐项读取。无依赖，未 install/update/复制 node_modules；typecheck/lint/
build/两 audit **NOT_RUN**，source 已交父串行一次 frozen install 后经 heavy.sh
验证。tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/
watch/review/Linear/清树均 NOT_RUN。不以静态相等代替运行验收，不预付 audit 或
main 收益；baseline 如有真实变化交父登记。未发现新的范围外 actionable follow-up。
