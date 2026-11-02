# Pi 上下文容量与历史保留策略（YUK-1572 / YUK-1570）

本片服务「帮助靠谱」的架构职责局部化。独立树
`/Users/yuqi/.t3/worktrees/the-learning-project/t3-0614f018`，分支
`arch/yuk-1572-pi-context-decisions`。起点旧 `c338877f` 经 `git fetch origin`
核得 `HEAD..origin/main=38`，从最新
`83bbecdaecaf70be0ae0241795fac3d5a07940c1` 新切，不带父旧 docs。
首轮源码 `a6d85a17a`，交付 `caf4e4d42`。父完成唯一一次 frozen install 后，
fetch 确认 main 前移至 `20222f2cafe1500a9e445b43fe132935405d825a`，仅三个
publication 路径；普通 merge `eee099ddb` 无冲突，双方 blob 保留。
恢复旧 type import 与最小换行后，首轮源码验证为 `586269c5e`。
父回执唯一 R1 对交付 source `b1b14b138275ff90670264857f162acdf4ca338c`
已 APPROVE。本轮 fetch 确认 main 为
`67506c5eaa5604ba34d2c943132343bf2e7fab5e`，普通 merge 无冲突，
新源码验证 head `fe10b9d7ebf1a8d7af2e68ddc8875fd1549dcfb1`，tree
`bc802fd702fedac86d27b43e7daa27d23853baad`；随后仅更新本文，不重开审查。

## 职责与授权

父核主线逐 hunk 占用后，明确允许原 `pi-agent-adapter.ts` 的估算、
`makeTransformContext` 算法及 `convertToLlm` 纯 role 过滤迁入内部模块。
只改该产品文件，新增同 family `pi-context-policy.ts`；无 re-export、
stable/compat、新 registry 或白名单。本片对 audit/schema/CI/package/lock/baseline、
测试、PLAN 均零 delta，不写其他树；保留主线上游全部变更，后续门由父线收口。

新模块 117 行，3 个同 family 入口，唯一 importer 是 adapter：

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
adapter **2121 → 2045，仍 >1500**，新模块 117，不为尺寸扩大范围。

## 逐文件保护与证据

`pi-agent-adapter.ts`：静态逆向恢复获准替换后，全文件与 base 逐字相等；
估算/constants 原文一致（仅 estimator 增内部 export）；选择体只将原
piUserMessage 绑定换成传入 factory、最终局部赋值换成 return、prefix 数组
按 Biome 换行；predicate/role filter 仅缩进不同。原 `PiMessage` type import
继续服务既有 aliases。所有 clock 调用表达式与源码顺序一致。
`EMPTY_PI_USAGE` + replay、user/SDK 消息构造、providerTransport、structured
submit/streamFn 直到文件结尾各段逐字相等，保留错误/usage/class/message identity。

R1 原 source 与新 head 的两个完整 blob 相同：adapter
`8ad42e79918f59b7bc9ede7bf60b220753581ba8`、policy
`530fbaf7c8fe72b6ac23dc257a0377572f0c538d`；本轮无源码或 body 修复。
main 的4460个非本片 tracked entries 全部相同，两处已退役 JSON 旧路径仍不存在。
baseline 整体 blob 与 main 相同，四组账本 `changes` 22、`edgeRecords` 20、
`sourceSizeRecords` 1、`compatShims` 7 均完整保留前缀且整组相同，delta=0。
逐文件清单与前缀证明见 source seal 的 `all-main-owned-blobs.json` 和
`review-main-prefix-proof.json`（SHA256
`38bc1579c9b1001c1f250b548f02722cb13ff899c82d4a22b2c1a326feb70967`）。

`pi-context-policy.ts`：只有 type imports；CJK 正则、计数序列化、85/60、
逆序预算循环、toolResult 配对及 session 判定原样归位。新导出均有上述真实
consumer；无独立 runtime consumer 扩面，无测试或付费入口。

最终源码 seal：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/fe10b9d7ebf1a8d7af2e68ddc8875fd1549dcfb1/pi-context-source-proof/`。
`sha256.json` SHA256 `89437247bf901a285f1cddc22ec74e1413bc83859a6ccc6639aa5611d37bfb84`；
`source-comparison.stdout` SHA256
`d06d3d1bc706fd76b2dbb36d3bde1c1b798708d6430b1ec11e43f4338bd08e11`。
每条命令 raw stdout/stderr、argv、UTC、真实 returncode 在各 `*.run.json`。
首轮 seal 保留：其 session-id 比较范围误含已迁 estimator；v2 只纠正比较范围，
产品源码没有为该证据修正而变化。

## 唯一 R1 后主线整合的实测验证

父安装回执：原 `caf4e4d42` 证据目录的 `parent-frozen-install.json/log`，
`heavy.sh pnpm install --frozen-lockfile` rc0；三项 package/lock/workspace
hash 前后同，merge 后仍同。writer 未 install/update/复制依赖。

最终源码 head 的 typecheck/lint/build/audit:capability-boundaries/
audit:architecture-deepening **全部 rc0**，均经外部 heavy.sh 单 lane 串行、全机
最多两槽；lint 180 warnings。原始日志与 argv/UTC/真实 rc：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/fe10b9d7ebf1a8d7af2e68ddc8875fd1549dcfb1/pi-context-five-gates-01/`。
`sha256.json` SHA256 `29fc63a22ac4118f2f3f37e331fd84861816fdbdd5e066df7c67e4be849cd554`。

审计 base 为 merge-base `67506c5eaa5604ba34d2c943132343bf2e7fab5e`，实测
394/0/37、新增依赖边0、server-entry新增边0、SCC 1（base 1）、超长13
（base 13）、pass-through 1088（+0）。超长14→13属上游 publication 片，
本片未退出超长清单。不改 baseline，当前 blob 与上游均为
`4c4154f785b0f2ae2dadc2f2e3223809117a8984`。本轮未执行 tighten 或手工登记。

首轮 typecheck rc1：本片误删仍被两个 aliases 使用的 `PiMessage` type import，
`5c92e07a2` 恢复原1行后通过。随后 lint rc1：本片 prefix 数组需格式换行，
`586269c5e` 最小修复后完整五门通过；不是上游错误，旧红日志保留在各原 head。
本轮仅合入 main，在新 exact source head 五门均通过，不追加源码修复或审查。
两文件 `node --check`、`git diff --check` 及静态源码/caller 比较仍通过。
tests/vitest/DB/TEST/Docker/daemon/provider/runtime/demo/paid、push/PR/watch/
新增 review/Linear/清树均 NOT_RUN。不以静态构建代替真实运行验收，不预付 main 收益；
未发现新的范围外 actionable follow-up。
