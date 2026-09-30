# YUK-1007 config read API lane — 批 2 handoff（2026-09-29）

- branch: `feat/yuk-1007-config-read-api`（批 1 = `f91d47c3f`，base `30353105d` = #1498 merge；批 2 commit 见 PR #1504 head）
- PR: https://github.com/Yukoval-Dakia/the-learning-project/pull/1504（`Refs YUK-1007`，不 Closes epic；**不 merge**——初审预算已用，parent 统一做唯一一次验证审）
- 状态（含后续更新）：批 2 之后本 branch 又交付了 YUK-1106 verdict reader 修复（`32aa55a6a`，**已碰** assessment-verdict.ts）与 CI-red 修正（`3c3cc9bf7`）——早期「未碰 verdict」的说法只对批 2 当次 commit 成立，对本 branch head 不成立。

## 批 2 交付面（批 1 keys[]/tasks[]/snapshot 之上）

- **P1 修复 global_pin**（Standards/OCR/Codex 三方确认）：`resolveGlobalPin` 的 DB 支路补 provider 门（镜像 providers.ts `readGlobalProviderSwitch` 的 `if (!db?.provider) return undefined`）——model-only DB 行运行时惰性，读面不再报 `{model}` 生效中。真实 resolver 对照回归（`hasGlobalProviderOverride()`=false + `resolveTaskProvider('AttributionTask')` 仍 xiaomi/mimo-v2.5-pro → 读面 `global_pin=null`）**RED→GREEN**（RED 证据：22 测 1 fail `Expected null, Received {model:'gpt-6-astra'}`）。原 unit 243-247 钉错值断言已改。
- **providers[]**：8 provider（anthropic/xiaomi/zhipu/openrouter/gateway/openai/anthropic-sub/opencode-go）×`{name, auth_mode, credential_env(名字), key_present(布尔), implemented}`；presence 用 `isProviderLaneReady`（providers.ts 单一真源，本批抽 `providerCredentialEnvName`），reserved lane（openrouter/gateway）如实 implemented=false；**值绝不序列化**（smoke + db 双 canary）。
- **schedules[]**：manifest 投影（capabilities[] 真实声明源，18 行）+ `INFRA_HOUSEKEEPING_SCHEDULES`（boss/handlers.ts 抽表，6 行）+ `MEMORY_INFRA_SCHEDULES`（memory/triggers.ts 抽表，3 行）；`read_only_note` 内置（只读/不触发 worker/DAG 成员无 cron 见 runtime）。**修正**：表驱动注册并非零行为变化——首批表项手写错队列名（verify_dispatch_recover）曾致 cron FK 违例拖死 worker-boot/verify-dispatch/extract 三面（CI run 36557897314，`3c3cc9bf7` 修复）；且 cron 注册后移到 registerHandlers 末尾改变了中途失败时已启动的 consumer 数量/时序（P2 裁定保留，rationale 见 handlers.ts 尾注）。
- **runtime**：port（env.ts `resolveApiPort` 单一真源，index.ts 同源改造）/ db pool（db/pool.ts `DB_POOL_MAX`）/ queue tiers（queue-config 导出常量）/ orchestration anchor（orchestration/constants）+ `dag_members`（kernel `projectDagMembers` 同源投影）。
- **configured↔effective 分列**：keys[].effective / effective_note 只来自**真实 reader 调用**（`ConfigEffectiveFacts` 各 capability `config-effective-facts.ts`：practice 11 键 + ingestion 1 + knowledge 4 + copilot 4 + notes 1 + observability 1 + server 直采 7）；无单一标量 effective 的键（admission×4 按 lane、JYEOO_BACKFILL 按会话）只给 note 不伪造。BACKUP_IMPORT_MAX_BYTES=1（env）→ value 1 / effective 1_000_000_000（实证修复）；DB 层因写端 schema min(1MB)+hydrate 校验构造上不可能分叉（已记入测试注释）。
- **装配 seam（零新边界）**：`server/config/admin-config-facts.ts`（组合根，自由 import 真相源）→ `observability/public.ts` setter（server→public 允许）→ route 每请求重调工厂（热加载新鲜）。capability-boundaries ratchet **450 exact 不动**（audit 通过）。server/index.ts boot 注入（动态 import 保 loadEnv 顺序）。

## 证据（可重跑）

- unit 28 绿：`pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/config-read-model.unit.test.ts`（含真实 resolver 回归 / schedules 投影 / injected-uninjected 诚实块 / secret canary / effective 分叉）
- 其余 unit：manifest 6 + composition 11 + memory/triggers 17 绿；boss/handlers.test 13 绿（DB 分区）
- DB 12 绿（真实 testcontainer + 真实 facts builder 注入 + providers 8 行字段面钉死 + schedules 三源行 + runtime 常量 + effective 写路径 round-trip）：`pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/api/admin-config.db.test.ts`
- typecheck / lint 299≤305 0 err / lint-ratchet OK / build 全绿（server/worker/migrate bundles）
- audits：capability-boundaries **450 exact 0 deep** / api-contracts 170/170 / partition / schema / api-client-usage 绿；api-client 随 regen 提交后过（`src/ui/lib/api-schema.generated.ts` 已再生成）
- 真实 HTTP smoke（真 Hono 挂载 + 真组合根 facts + 401×2/200 + providers/schedules/runtime/effective/global_pin/P1 场景全 PASS）：日志在批准 temp 目录 `…/T/opencode/yuk1106/20-http-smoke-p1.log`（`.omo/` 本仓库 gitignored，不入库；脚本 `.cache/admin-config-http-smoke/smoke.ts` 可重跑）。**证明边界**：smoke 用哑 DATABASE_URL + runnable epochGate 注入，只证明 HTTP 装配与读面事实，**不是** startup-tail 完整黑盒——compiled worker 的 READY→SIGTERM exit 0 由 QA 独立证据覆盖（`…/T/opencode/yuk1106-final-qa/07/08`）。
- **P1 修复（验证审反例，`32aa55a6a` 后续 commit）**：solve-lane 覆盖（VERIFY_SOLVE_*）与 lane.global.* 的 keys[].effective 改接**真实 runtime reader**（resolveSolveOverrideFromEnv 降级文本 + readGlobalProviderSwitch 导出投影）——凭据缺失 pair → effective=null+reader 降级说明；model-only global → effective=null+惰性说明；valid pair → 真值。API+真 facts 回归旧 RED→GREEN（temp 18/19 号日志）+ 真实 HTTP 针对性场景（20 号）。
- 本文件 737 行历史版可 `git show 30353105d:.remember/now.md` 取回（archive 指针，不回灌大日志）。

## 留给 parent 的事

1. **验证审**（唯一一次）：五 lane 初审已毕，本批修复后的 diff 由 parent 统一安排；P1/P2 回复——push 后再回复 fixed（global_pin = Codex P2 `Suppress model-only global pins` + OCR 同项已修；`Report consumer-effective values` 已按"expose raw and effective separately"修复）。
2. **Linear**：YUK-1007 保持 In Progress（budget/locale reader 迁移、UI、写面未做——不声称 all hot reload 完成）；若需要票内 comment 由 parent 补。
3. **YUK-1106**：批 2 当时未碰该文件（成立）；后续同 branch 的 `32aa55a6a` 已修复（kernel reader 候选排序 + seam/真库回归，CI 各分片 assessment-verdict 全绿）。「未碰」仅指批 2 commit 范围，勿再按 branch 级理解。
4. 复核建议关注点：boss/handlers.ts + memory/triggers.ts 的表驱动注册（**非**零行为变化——见上修正与 handlers.ts 尾注的 P2 rationale）；5 个 public.ts 新增窄导出；providers.ts `providerCredentialEnvName` 抽取。
