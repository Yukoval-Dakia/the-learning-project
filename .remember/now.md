# YUK-1007 config read API lane — 批 2 handoff（2026-09-29）

- branch: `feat/yuk-1007-config-read-api`（批 1 = `f91d47c3f`，base `30353105d` = #1498 merge；批 2 commit 见 PR #1504 head）
- PR: https://github.com/Yukoval-Dakia/the-learning-project/pull/1504（`Refs YUK-1007`，不 Closes epic；**不 merge**——初审预算已用，parent 统一做唯一一次验证审）
- 状态：owner 批准的扩面 + 初审修复已实现并本地验证完成；push 后 CI 以新 HEAD exact-head 跑（YUK-1106 blocker 归 parent 另派，本 lane 未碰 assessment-verdict 及其依赖）。

## 批 2 交付面（批 1 keys[]/tasks[]/snapshot 之上）

- **P1 修复 global_pin**（Standards/OCR/Codex 三方确认）：`resolveGlobalPin` 的 DB 支路补 provider 门（镜像 providers.ts `readGlobalProviderSwitch` 的 `if (!db?.provider) return undefined`）——model-only DB 行运行时惰性，读面不再报 `{model}` 生效中。真实 resolver 对照回归（`hasGlobalProviderOverride()`=false + `resolveTaskProvider('AttributionTask')` 仍 xiaomi/mimo-v2.5-pro → 读面 `global_pin=null`）**RED→GREEN**（RED 证据：22 测 1 fail `Expected null, Received {model:'gpt-6-astra'}`）。原 unit 243-247 钉错值断言已改。
- **providers[]**：8 provider（anthropic/xiaomi/zhipu/openrouter/gateway/openai/anthropic-sub/opencode-go）×`{name, auth_mode, credential_env(名字), key_present(布尔), implemented}`；presence 用 `isProviderLaneReady`（providers.ts 单一真源，本批抽 `providerCredentialEnvName`），reserved lane（openrouter/gateway）如实 implemented=false；**值绝不序列化**（smoke + db 双 canary）。
- **schedules[]**：manifest 投影（capabilities[] 真实声明源，18 行）+ `INFRA_HOUSEKEEPING_SCHEDULES`（boss/handlers.ts 抽表，6 行，注册改由表驱动零语义变化）+ `MEMORY_INFRA_SCHEDULES`（memory/triggers.ts 抽表，3 行）；`read_only_note` 内置（只读/不触发 worker/DAG 成员无 cron 见 runtime）。
- **runtime**：port（env.ts `resolveApiPort` 单一真源，index.ts 同源改造）/ db pool（db/pool.ts `DB_POOL_MAX`）/ queue tiers（queue-config 导出常量）/ orchestration anchor（orchestration/constants）+ `dag_members`（kernel `projectDagMembers` 同源投影）。
- **configured↔effective 分列**：keys[].effective / effective_note 只来自**真实 reader 调用**（`ConfigEffectiveFacts` 各 capability `config-effective-facts.ts`：practice 11 键 + ingestion 1 + knowledge 4 + copilot 4 + notes 1 + observability 1 + server 直采 7）；无单一标量 effective 的键（admission×4 按 lane、JYEOO_BACKFILL 按会话）只给 note 不伪造。BACKUP_IMPORT_MAX_BYTES=1（env）→ value 1 / effective 1_000_000_000（实证修复）；DB 层因写端 schema min(1MB)+hydrate 校验构造上不可能分叉（已记入测试注释）。
- **装配 seam（零新边界）**：`server/config/admin-config-facts.ts`（组合根，自由 import 真相源）→ `observability/public.ts` setter（server→public 允许）→ route 每请求重调工厂（热加载新鲜）。capability-boundaries ratchet **450 exact 不动**（audit 通过）。server/index.ts boot 注入（动态 import 保 loadEnv 顺序）。

## 证据（可重跑）

- unit 28 绿：`pnpm vitest run --config vitest.unit.config.ts src/capabilities/observability/server/config-read-model.unit.test.ts`（含真实 resolver 回归 / schedules 投影 / injected-uninjected 诚实块 / secret canary / effective 分叉）
- 其余 unit：manifest 6 + composition 11 + memory/triggers 17 绿；boss/handlers.test 13 绿（DB 分区）
- DB 12 绿（真实 testcontainer + 真实 facts builder 注入 + providers 8 行字段面钉死 + schedules 三源行 + runtime 常量 + effective 写路径 round-trip）：`pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/api/admin-config.db.test.ts`
- typecheck / lint 299≤305 0 err / lint-ratchet OK / build 全绿（server/worker/migrate bundles）
- audits：capability-boundaries **450 exact 0 deep** / api-contracts 170/170 / partition / schema / api-client-usage 绿；api-client 随 regen 提交后过（`src/ui/lib/api-schema.generated.ts` 已再生成）
- 真实 HTTP smoke（真 Hono 挂载 + 真组合根 facts + 401×2/200 + providers/schedules/runtime/effective/global_pin 25 项全 PASS）：**artifact `.omo/evidence/yuk-1007/2026-09-29-admin-config-http-smoke-b2.log`**（脚本 `.cache/admin-config-http-smoke/smoke.ts`，可重跑）

## 留给 parent 的事

1. **验证审**（唯一一次）：五 lane 初审已毕，本批修复后的 diff 由 parent 统一安排；P1/P2 回复——push 后再回复 fixed（global_pin = Codex P2 `Suppress model-only global pins` + OCR 同项已修；`Report consumer-effective values` 已按"expose raw and effective separately"修复）。
2. **Linear**：YUK-1007 保持 In Progress（budget/locale reader 迁移、UI、写面未做——不声称 all hot reload 完成）；若需要票内 comment 由 parent 补。
3. **YUK-1106**：CI blocker（run 36444482025，f91d47c，DB shard 2/4 assessment-verdict.db.test.ts:332）归 parent（oracle 调查中）；本 lane 未碰该文件及其依赖实现，也未同 SHA 重跑遮红。
4. 复核建议关注点：boss/handlers.ts + memory/triggers.ts 的表驱动注册（行为零变化的机械重构）；5 个 public.ts 新增窄导出；providers.ts `providerCredentialEnvName` 抽取。
