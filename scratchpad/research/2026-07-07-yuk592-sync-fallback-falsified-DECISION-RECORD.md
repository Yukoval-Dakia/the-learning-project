# YUK-592 — anthropic-sub 作 vision judge 真 fallback（design draft）

Status: DRAFT — 等 coordinator 对抗面板判词；判词前零测试零生产代码
Author: Lane G (ultrawork Wave 2)
Date: 2026-07-07
Scope issue: Linear YUK-592 — owner 已拍板「开，裸 fallback，无日额度上限」
Base: origin/main @ cf1ae85d（含 PR #730 / YUK-576 六门重试循环 + AgentRunError + RETRY_ELAPSED_CAP_MS）

---

## 0. 本单是什么（一句话）

YUK-576 §8 把「anthropic-sub Opus 跨 provider vision judge 真 fallback」列为 **owner 决策项**，落点建议 `VISION_JUDGE_*` env 杆 + 既有 retry 循环的**有限扩展**（§1.2.4：「不是 42 个 def 里的 per-task 数据」）。owner 已批「开」。本单就是那条重加路径的兑现：mimo primary lane 瞬时挂时，两个 vision judge 自动补一次 anthropic-sub（Opus 4.8，Max 订阅 OAuth）尝试，判分不中断。

**核心不变量（红线）**：默认（`VISION_JUDGE_FALLBACK_PROVIDER` 未设）全仓 42 任务 + 两个 judge **byte-identical**；fallback 只在显式 env + 既有 opt-in + 未钉死路由时对两个 judge 生效；同步路由墙钟 ≤ ~100s（cloudflared 边缘上限）不破。

---

## 1. 触发点精确定义（设计问题 ①）

**决策：fallback 触发条件 = `isTransientAgentFailure(err) === true`（复用 §2.3 冻结谓词），且 primary lane 的 transient 重试已耗尽（或 transientRetries=0 时首挂即判），且过墙钟门（§2）。permanent 失败照今天直接抛，绝不 fallback。**

理由：fallback 是**端点级冗余**——「mimo 端点真挂 → 试另一个端点」。冻结分类表里的 transient 家族（连接类 null / 429 / 5xx / stream_no_terminal）**正是端点健康信号**；permanent 家族（400/401/404 = 请求/鉴权/校验坏、error_max_* = 预算/轮次耗尽、abort/timeout）是 **provider 无关**的问题，换 Opus lane 也一样挂，只会白烧订阅额度。

分类矩阵（哪些 subtype/family → fallback）：

| 失败形态 | isTransient | fallback（过门时） | 备注 |
|---|---|---|---|
| `api_error_result` + null（连接类，mid-drop 探针 1.5s） | transient | **YES** | 快到达，稳过墙钟门；主实战面 |
| `api_error_result` + 429 / 5xx | transient | 合格但**实战被墙钟门挡** | 实测 ~3min 才到（CLI api_retry ×10 耗尽）→ elapsed ≥ cap → 不触发（保墙钟；诚实保留行） |
| `api_error_result` + 其它 4xx（400/401/404） | permanent | **NO** | 请求/鉴权坏，换 lane 无解 |
| `stream_no_terminal` | transient | **YES** | 进程级快失败 |
| `error_during_execution` | permanent | **NO** | 探针证 API 故障从不落此（v3.1 翻转） |
| `error_max_turns / _budget_usd / _structured_output_retries` | permanent | **NO** | 换目标不解决 |
| abort / timeout（budget.timeout 计时器） | permanent | **NO** | §2 墙钟 |
| `resolveTaskProvider` config 错（primary，pre-row） | 不进分类器 | **NO** | 照今天上抛 |

**与 retry 的关系（同一谓词，不同动作）**：retry = 同目标再打一次（吸收同端点抖动）；fallback = 换端点打一次（吸收整端点挂）。二者共用 `isTransientAgentFailure` + 同一墙钟门；fallback 在 primary lane（含 retry）**全部耗尽后**才作为最后一跳。实战上，因 429/5xx 到达太慢被门挡，fallback 与 retry 一样主要吃**快失败**（连接类/流级）。这是同步路由的诚实边界：**慢挂无法既救又保 100s 墙钟**（见 §2）。

---

## 2. 墙钟语义 + 最坏算术（设计问题 ②）

**决策：fallback 复用 `RETRY_ELAPSED_CAP_MS`（10s，从 `firstAttemptStartedAt` 起算）作触发墙钟门；fallback 尝试本身用 judge 的 `budget.timeout`（90s，anthropic-sub 走同一 registry budget）。mimo 慢失败（elapsed ≥ 10s）时 fallback 直接放弃。**

**为什么复用同一个 10s cap 而不是独立 cap**：cloudflared 边缘空闲断连 ~100s（YUK-576 §3.4，docker-compose.yml:132-137）是硬顶。fallback 尝试要跑满 90s（Opus 判分需可比时长，不缩短），所以触发门必须 ≤ 10s 才能让 `门 + 90s ≤ 100s`。10s 恰是 `RETRY_ELAPSED_CAP_MS` 现值 → 复用，让 100s 不变量与**单一常量**耦合，不新增可漂移的旋钮。

**最坏墙钟算术（含 retry×fallback 叠加，判词 mustFix#3 同款按调用面）**：

关键不变量：**所有非末跳（retry）必须挤进首跳起算的 10s 窗内，且全程只有一次跑满 90s 的末跳**（要么末次 primary，要么 fallback，二者互斥其一跑满）。

- 快失败链（fallback 触发）：attempt1 连接类 1.5s 挂 → retry attempt2 连接类 1.5s 挂（elapsed 3s < 10s）→ primary 耗尽，elapsed 3s < 10s → **fallback（Opus）跑满最坏 90s** → 总 ≈ **93s ≤ 100s** ✓
- 门临界：primary 两跳在 elapsed 9.9s 处耗尽 → fallback 90s → **99.9s ≈ 100s** ✓（10s + 90s 是数学上界）
- 慢失败（fallback 放弃）：attempt1 跑满 90s 才挂 → elapsed 90s ≥ 10s → 无 retry 无 fallback → 总 **90s**，落 `unsupported`（与今天同）✓
- 混合：attempt1 快挂 1.5s → retry attempt2 慢挂 90s → elapsed 91.5s ≥ 10s → 无 fallback → 总 **91.5s**（≈ 今天 retry 上界）✓

**结论**：worst-case = `RETRY_ELAPSED_CAP_MS + max(budget.timeout)` = 10s + 90s = **100s，与今天 retry 上界逐字相同**——fallback 占的是「本会成为第二次 primary attempt」的墙钟槽位，不新增第三个 90s 窗。慢挂（60-89s 才失败）**直接放弃 fallback**（elapsed ≥ 10s，门自动挡），墙钟不破。后台 job 面不适用（durable 路径 opt-in 门第一道就关，见 §3）。

---

## 3. 门控矩阵（设计问题 ③）

**决策：fallback 复用 `transientRetryEnabled(ctx)` 全部三道门（opt-in / ctx.override 未钉 / AI_PROVIDER_OVERRIDE 未钉），额外加第四道「fallback 目标存在」门。不新增独立 opt-in 开关。**

推导：fallback 与 retry 是**同一资质**——「无 durable backstop 的同步 sensor 路径可用进程内韧性」。两个 vision judge 的 catch 吞成 `unsupported`，pg-boss 永不见 throw（§1.2.2 点名的无-backstop 面），既是 retry 的合法面也是 fallback 的合法面。复用 `transientRetryEnabled` 意味着：

- **opt-in 门**（`ctx.enableTransientRetry === true`）：R6 grep-pin（`retry-optin.test.ts`）已钉死恰两处 = 两 judge 文件。fallback 复用此门 → **不新增 opt-in 面，R6 保证不动**，durable handler 永不 fallback（唯一-transient-层原则 mustFix#6 延续到 fallback）。
- **ctx.override 未钉门**（`!ctx.override?.provider && !ctx.override?.model`）：**这是 YUK-573 承重保护点**（见下）。
- **AI_PROVIDER_OVERRIDE 未钉门**（`!hasGlobalProviderOverride()`）：全局钉死 = operator 显式决策，fallback 关。

第四道门（fallback 特有）= `ctx.fallbackOverride` 存在。它由 judge 调用点经新 reader `visionJudgeFallbackProviderOverride()` 计算并 thread 进 ctx（与 `ctx.override = visionJudgeProviderOverride()` 对称）；env 未设 / token 缺失 → 返回 undefined → 第四道门关（§5）。

**门控矩阵：**

| 场景 | ctx.override | fallbackOverride | fallback |
|---|---|---|---|
| 默认 judge，`VISION_JUDGE_FALLBACK_PROVIDER` 未设 | undefined | **undefined** | **OFF（byte-identical 红线）** |
| 默认 judge，`VISION_JUDGE_FALLBACK_PROVIDER=anthropic-sub` + token 在场 | undefined | `{anthropic-sub}` | **ON**（硬要求满足） |
| `VISION_JUDGE_PROVIDER=anthropic-sub`（primary 已钉 Opus） | `{anthropic-sub}` | —(门2关) | OFF（primary 本就 Opus，无冗余可加；operator 钉死） |
| 全局 `AI_PROVIDER_OVERRIDE` 钉死 | — | —(门3关) | OFF |
| **YUK-573 校准 rejudge**（`judge-calibration-sample-core.ts:378-386` spread 后钉 `override:{anthropic-sub}`） | `{anthropic-sub}` | —(门2关) | **OFF（承重保护）** |
| durable handler（不设 enableTransientRetry） | — | —(门1关) | OFF |
| `VISION_JUDGE_FALLBACK_PROVIDER` 设但 OAuth token 缺失 | undefined | **undefined（reader 降级+warn）** | fallback 级 **SKIP**（§5） |

**YUK-573 校准 rejudge 绝不被干扰的保证 + 测试**：校准采样把 `override:{provider:cfg.rejudgeProvider}` **spread 在 `...ctx` 之后**（S5，第二 lane 必须赢）→ `ctx.override.provider` 真值 → `transientRetryEnabled(ctx)` 第二道门返回 false（runner.ts:536）→ fallback 门（复用同函数）同步关 → 校准 rejudge **恰在 `cfg.rejudgeProvider` 上跑一次，无静默跨 lane 污染**，agreement 统计纯度保持。这与既有 S5 spread-order 承重回归测试是**同一道门**——fallback 复用门即继承保护；仍加一条 fallback 专项断言（override 钉死时 `capturedOptions.length === 1`，无 fallback attempt）。

---

## 4. 观测（设计问题 ④）

**决策：**
- **fallback 触发行 finish_reason = `'error_failover'`**（新值；#730 的 `error_retried` 是「可区分 finish_reason」先例；`finish_reason` 是自由 text 列 `schema.ts:620`，无闭枚举，加新值零 migration）。语义：primary lane 末跳失败**但补了 fallback**——不是逻辑失败末级，是「转投」痕迹。
- **fallback 尝试自身**：成功 → `runTaskAttempt` 照写 `status='success'`，`provider='anthropic-sub'` / `model='claude-opus-4-8'`（判分 lane 痕迹天然携带，问题 ③ 采样分层免费——YUK-573 MF5 已能按 provider 分层）；失败（末级）→ `'error'`（被 watchdog 计）。
- **触发 breadcrumb**：`console.warn('[runTask] task_run_cross_lane_fallback', { event, kind, task_run_id, from_provider, to_provider, elapsed_ms })`——与 `task_run_transient_retry` 对称、同量级、零新 schema；慢性 mimo 挂在日志面呈连续 warn 流可被监控拾取。

**与 degraded_kinds watchdog（只计末级）的交互**——**必须改（不可分离，同 #730 把 watchdog 修复与 retry 捆绑的先例）**：

`overnight-digest.ts:116-118` 现过滤 `status='failure' AND finish_reason IS DISTINCT FROM 'error_retried' AND ... 'reconciled_stuck'`。加第三条 `AND finish_reason IS DISTINCT FROM 'error_failover'`。真值语义：

- **fallback 救回**（primary error_failover + fallback success）：逻辑请求**成功** → 应计 0。error_failover 行被排除、fallback success 非 failure → **计 0** ✓
- **彻底失败**（primary error_failover + fallback error）：逻辑请求失败 → 应计 1。fallback 'error' 计 1，primary error_failover 排除（否则一次逻辑失败被双计）→ **计 1** ✓

`DEGRADED_KIND_ERROR_THRESHOLD=2`「2 个独立逻辑失败才标红」语义保持，不改阈值数值，注释补一行「排除 error_failover（YUK-592，与 error_retried 同族：非末级逻辑失败）」。

**翻查面故意保留**（R3/R5 纪律延续）：admin Failures 页（`observability.tsx`）按 finish_reason 聚类且**故意不加 sub-filter**——`error_failover` 自然形成独立聚类，慢性 mimo flaky（连续转投 Opus 救回）表现为持续增长的 error_failover cluster，肉眼可见。**alerting 面排除、翻查面保留**——无 observability.tsx 代码变更（deliberate）。

---

## 5. token 缺失 = skip 语义（设计问题 ⑤）

**决策：显式 skip-on-resolve-error，落点在新 reader `visionJudgeFallbackProviderOverride()`（vision-judge-config.ts），与既有 `visionJudgeProviderOverride()` degrade-before-call 逐字对称。**

reader 语义（三态）：
1. `VISION_JUDGE_FALLBACK_PROVIDER` 未设 → `undefined`（默认；judge fallbackOverride undefined → 门4关 → byte-identical）。
2. 命名了 OAuth-lane provider（`isOauthProvider`，当前仅 anthropic-sub）但 `CLAUDE_CODE_OAUTH_TOKEN` 缺失 → **warn + 返回 undefined**（fallback 级静默跳过，judge 落 `unsupported` 携 primary 错——与今天无 fallback 时**逐字节相同**）。
3. 否则 → `{ provider, model? }`（model 仅当 `VISION_JUDGE_FALLBACK_MODEL` 设；否则 resolver 供 lane 默认 claude-opus-4-8）。

**operator 意图偏差显式声明**（写进 reader docblock + warn 文案）：operator 设了 fallback lane 但漏了 OAuth token → fallback **静默跳过**、judge 落 unsupported。与 §1.2.1「缺 token 只是 resolve 失败跳过该级 = 与今天同，skip-on-resolve-error 语义自洽」一致，与 `visionJudgeProviderOverride()` 的 primary degrade 对称。warn `task_run_fallback_skipped_no_token`（或 reader 内 console.warn）让 misconfig 浮出。测试覆盖：env 设 + token 缺 → reader 返回 undefined + warn；judge 端 fallbackOverride undefined → 无 fallback attempt。

**防御纵深**：token 存在性校验在 reader（degrade-before-call），故 runner 到 fallback 时 `ctx.fallbackOverride` 只在可解析时存在；runner 仍对 `resolveTaskProvider(kind, ctx.fallbackOverride)` 包 try/catch，throw 则 skip + 抛原 primary 错（belt-and-suspenders，非 oauth misconfig 兜底）。

---

## 6. 全局 42 任务零差异守卫（设计问题 ⑥）

fallback 生效需**同时**：`enableTransientRetry:true`（R6-pin 恰两 judge 文件）+ `ctx.fallbackOverride` 存在（仅两 judge 经 reader 设，且仅 `VISION_JUDGE_FALLBACK_PROVIDER` 设时非空）+ 三道路由门过。任何其它任务：从不设 enableTransientRetry → 门1关 → `maxAttempts` 不变、无 fallback attempt → **byte-identical**。默认（env 未设）：连两个 judge 都 fallbackOverride=undefined → 无 fallback → 逐字节今天。

守卫测试：① `runner.seam.test.ts` EXPECTED_KEYS 不破（fallbackOverride 只喂 runTask 循环算 fallback resolved，**不进 buildQueryOptions/Options**；fallback attempt 的 Options 由正常 ResolvedProvider 构造，key 集不变）；② 「fallback env 未设 → 两 judge byte-identical（capturedOptions.length===1，无 error_failover 行）」；③（推荐，防未来漂移）symmetric grep-pin：`ctx.fallbackOverride` 赋值站点恰两 judge 文件（与 R6 对称；虽门1已兜底，honesty 守卫廉价）。

---

## 7. 实现骨架（既有循环的有限扩展，§1.2.4 措辞）

`runTask` 主循环保持不动（primary lane + 六门 retry）；**末跳失败后**插一次 fallback attempt。复用 `runTaskAttempt(resolved)`（YUK-576 已把 resolved 做成入参 = per-entry override 缝）：

```
maxAttempts = 1 + (transientRetryEnabled(ctx) ? def.budget.transientRetries : 0)
firstAttemptStartedAt = now
for attempt in 1..maxAttempts:
  resolved = resolveTaskProvider(kind, ctx.override)        // 同目标（primary lane）
  try: return runTaskAttempt(kind, ..., resolved)
  catch err:
    elapsed = now - firstAttemptStartedAt
    willRetry    = attempt < maxAttempts && isTransient(err) && elapsed < CAP
    willFallback = !willRetry && fallbackEligible(ctx, err, elapsed)
                   // = isTransient(err) && elapsed < CAP && transientRetryEnabled(ctx) && ctx.fallbackOverride
    finishReason = willRetry ? 'error_retried' : (willFallback ? 'error_failover' : 'error')
    writeFinished(failure, finishReason, err.taskRunId ?? taskRunId, err.message)
    if willRetry:    breadcrumb('task_run_transient_retry'); continue
    if willFallback: breadcrumb('task_run_cross_lane_fallback', {from,to,elapsed}); break
    throw err
// —— fallback 末跳（仅经 willFallback break 到达）——
try:
  fallbackResolved = resolveTaskProvider(kind, ctx.fallbackOverride)   // token 已由 reader 前校验
catch resolveErr:
  throw lastErr                                                        // skip-on-resolve-error，抛原 primary 错
try: return runTaskAttempt(kind, ..., fallbackResolved)               // 成功→success 行(provider=anthropic-sub)
catch fbErr:
  writeFinished(failure, 'error', fbErr.taskRunId ?? id, fbErr.message)  // 末级，被计
  throw fbErr
```

红线复核：成功零差异（首跳成功即 return）；无限循环不可能（primary maxAttempts=2 + 至多一次 fallback = 全仓 ≤3 跳，无 while 无递归）；计费诚实（真发生 N 跳记 N 行，ledger 只记成功跳）；误触发最小化（opt-in + 2 路由门 + fallbackOverride 门 + 白名单分类 + 墙钟门，全过才 fallback 一次）。

---

## 8. 文件级变更清单（预估）

| 文件 | 变更 |
|---|---|
| `src/server/ai/vision-judge-config.ts` | 新增 `VISION_JUDGE_FALLBACK_PROVIDER` / `VISION_JUDGE_FALLBACK_MODEL` flag 常量 + `visionJudgeFallbackProviderOverride(env)` reader（degrade-before-call，与 visionJudgeProviderOverride 对称） |
| `src/server/ai/runner.ts` | RunTaskCtx 增 `fallbackOverride?`；runTask 循环末跳后 fallback attempt（有限扩展）；`fallbackEligible` 门（复用 transientRetryEnabled）；finish_reason 真值表增 `error_failover`；`task_run_cross_lane_fallback` breadcrumb |
| `src/server/ai/judges/steps-judge.ts` / `multimodal-direct-judge.ts` | 调用点 ctx 增 `fallbackOverride: visionJudgeFallbackProviderOverride()` |
| `src/capabilities/shell/server/overnight-digest.ts` | watchdog 过滤增 `finish_reason IS DISTINCT FROM 'error_failover'` |
| `src/capabilities/shell/server/overnight-digest-summary.ts` | THRESHOLD 注释补 error_failover 排除说明 |
| `docs/design/2026-07-07-yuk576-registry-honesty.md` | §8 表 owner-决策行标注「已由 YUK-592 兑现（PR link）」 |
| `docs/adr/0003-defer-ai-provider-abstraction.md` | :37 supersede 注追一行：跨 provider judge fallback owner-决策已在 YUK-592 经 VISION_JUDGE_FALLBACK_PROVIDER 落地 |
| 新测试 | `runner.fallback.test.ts` 扩：fallback 触发/救回/彻底失败/慢挂放弃/permanent 不 fallback/override 钉死不 fallback（YUK-573）/env 未设 byte-identical；vision-judge-config 测试：reader 三态（未设/token缺/正常）；judge 消费：fallbackOverride 透传；watchdog DB 测试：error_failover 排除；（推荐）fallbackOverride grep-pin |

跨 lane 撞车：overnight-digest.ts 属 shell capability（Lane H/I 在 copilot，无交集）；registry.ts **不改**（本单不碰 per-task 数据，§1.2.4）→ 与 Lane H/I 的 CopilotTask budget 无撞。

---

## 9. 开放问题（等判词）

1. **fallback 墙钟门 = 复用 `RETRY_ELAPSED_CAP_MS`（10s）还是独立 `FALLBACK_ELAPSED_CAP_MS`？** 推荐复用（100s 上界与单一常量耦合，不新增可漂移旋钮；见 §2）。独立常量的唯一理由是未来想让 fallback 门比 retry 门更宽/更窄——但更宽会破 100s，更窄无收益，故推荐复用。
2. **fallback opt-in = 复用 `enableTransientRetry` 门（推荐）还是新增 `ctx.enableCrossLaneFallback`？** 推荐复用（不新增 opt-in 面，R6 pin 不动，符合「有限扩展」）。代价：`enableTransientRetry` 语义从「同目标重试」扩为「进程内韧性（含跨 lane fallback）」，需更新 field docblock 诚实描述。若面板认为命名诚实性 > 表面最小化，可选独立 flag（+一条 grep-pin）。
3. **fallback 分类 = 严格 `isTransientAgentFailure`（推荐）还是纳入部分 permanent（如某些 endpoint-specific 4xx）？** 推荐严格 transient（permanent 是 provider 无关问题，fallback 白烧 Opus）。owner「裸 fallback 无日上限」偏可用性，但「端点真挂」= transient 家族，permanent 换 lane 无解——严格 transient 已服务 owner 意图。
4. **`error_failover` 是否需进 admin UI 的 finish_reason 图例/badge 白名单？** 现状 observability 把 finish_reason 当不透明聚类键（§4），无需改；仅确认面板是否要显式 UI 认知（默认不改，deliberate）。
5. **YUK-576 §8 doc + ADR-0003 补注要不要做？** 本 draft 判「要」（§8 是本单的重加路径出处，ADR-0003:37 是在世决策记录）——各一行注记，honest。若面板认为跨 doc 编辑出 scope 可砍到只留本 doc。

---

## 10. TDD 计划（判词绿灯后执行，RED 先行）

1. **reader**（unit）：`visionJudgeFallbackProviderOverride` 三态——未设→undefined；anthropic-sub+token缺→undefined+warn；anthropic-sub+token在→`{provider,model?}`；非 oauth provider 透传不校验。
2. **fallback 循环**（`runner.fallback.test.ts` 扩，no-DB SDK-mock）：env 设+快 transient primary 全挂→fallback attempt(2 or 3 次 query)、末跳 provider=anthropic-sub、救回 success；primary error_failover 行 + fallback success 行；fallback 也挂→'error' 末级 + 抛；**慢挂（elapsed≥cap）→ 不 fallback**；permanent→不 fallback 直抛；**override 钉死→不 fallback（YUK-573 承重）**；AI_PROVIDER_OVERRIDE→不 fallback；env 未设→byte-identical（length===1，无 error_failover）；同 input_hash、beforeRun 一次。
3. **judge 消费**：defaultRunTaskFn ctx 带 fallbackOverride；注入 runTaskFn 断言透传；（推荐）grep-pin fallbackOverride 恰两处。
4. **watchdog**（DB）：error_failover 排除、救回计 0、彻底失败计 1、阈值语义。
5. 全量 gate（typecheck/lint/audit×4/test/build）+ fake-completion 自查 + 独立 Opus 对抗 review（喂全量 diff）。
