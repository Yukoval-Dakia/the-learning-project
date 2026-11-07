# 配置盘点片 S5 证据（YUK-1869 / YUK-1677）

- tested head: `844fdcbecb9ef167bbf54320f0ce53637c90f6b2`（tree `bc039926515bddba7de9ef0769dd14cba2b67204`）
- base: `4497ab0bbda8803844c1f60d4b210dba207d7f58`（origin/main，tree `5dd48ba298daca8681c2da785ced7731fe010c5f`）
- 两份树都由 `git archive` 导出到外置盘 `/Volumes/YukovalSBak/yukoval-projects/tlp-build/yuk-1869-s5/{base,head}`；同一份 `probe.ts` 跑两次。无 DB、无 env 覆盖、无模型调用。
- 本目录后的提交只加证据，不改代码；evidence 提交之后的代码与 tested head 相同。

## 1. 58 个任务解析结果 base/head 逐字节

探针取真实 `taskCatalog`（`composeTaskCatalog(..., 58)`），按 kind 排序，逐任务经纯配置链输出：
`selectPairProvider({defaults})`、`selectPairModel({defaults})`、`selectReasoningRequest({global: registry lane.global.reasoning codeDefault})`、`canonicalHash(definition.prompt)`。

- 输出 59 行（`count=58` + 58 行），`base.out` 与 `head.out` 的 SHA256 都是 `57760bd9234d81a32908edaa05a96813d1c36e6c4d125c9cf3c168deac817bae`，`cmp` 无差异。
- pair 分布：55 个 `opencode-go/deepseek-v4.1-flash`，2 个 `openai/gpt-6.1-sol`（DrawingTask、QuestionAdmissionAdjudicateTask），1 个 `openrouter/typesafe/jev-1.13`（JevScoringDecisionTask）。
- reasoning 全部 `high@global:lane.global.reasoning`（58 个任务都没有 `reasoningEffort` 覆盖，base 亦然）。
- prompt hash 逐任务包含在输出里，两边相同。

判分身份：`model_version = ${version}:${binding.provider}:${canonicalHash(definition.prompt)}${wireReasoning}`（`model-slice-registry.ts:76`）。provider 与 prompt hash 都在上面的逐任务输出里相同；`wireReasoning` 来自 reasoning 解析，58 行也相同；version 常量与 `src/core/config/registry.ts` 均未改动（registry 两边 SHA256 都是 `d2825482431bb775a3b3781ef8cf2e5d72d3cdcb57b264b7c3134c837b916896`）。`git diff base..head -- 'src/capabilities/**/tasks/**' src/core/config/registry.ts src/core/config/server/env.ts` 为空。

## 2. 模型 id 字面量全量分类

用 `audit:model-source.ts` 对空 tree commit（`3d28c11adb2ad8948c99a20b0568fa958cbe4502`）跑 head，列出所有**不在允许站点**的字面量：22 条，全部 base 已存在、被审计按 base 预算放行，0 新增（`literal-census.txt`）。分类：

| 类 | 数量 | 位置 | 判断 |
|---|---:|---|---|
| 允许：全局任务默认 | 1 文件 | `src/core/config/model-overrides.ts:17-18` | 本片新建的唯一全局默认站点 |
| 允许：任务专用默认 | 3 文件 | `drawing-task.ts:72-73`、`jev-typed.ts:26-27`、`question-admission-adjudicate.ts:169-170` | 专用协议任务，保留显式绑定 |
| 允许：catalog / 定价 / provider 表 | 3 文件 | `providers.ts`、`pricing.ts`、`model-catalog-overrides.ts`（另有 snapshot JSON） | catalog 面 |
| 允许：registry codeDefault | 1 处 | `registry.ts:610` `claude-opus-4-8` | `*_MODEL` 键的 codeDefault |
| 非允许：脚本 | 13 条 | `audit-provider-lanes.ts` 3（其中 3 条是 `glm-ocr-layout-parsing-fetch` 的 substring 误命中）、`gen-model-catalog.ts` 1、`provider-lane-inventory.ts` 9 | catalog 生成脚本 / 说明字符串；base 已存在 |
| 非允许：TEST pin 脚本 | 5 条 | `yuk1537-admission-reopen.ts` | ops 脚本的显式 TEST pin；base 已存在 |
| 非允许：release rehearsal 夹具 | 4 条 | `src/server/release/rehearsal/corpus.ts:1154,1169,1176,1187` | 合成 corpus 的响应模型串；base 已存在 |

`src/capabilities/agency/jobs/coach_daily.ts:419` 只是注释（"deepseek-v4.1-flash seen 2026-11-04"），不是字面量；`providers.ts` 的硬写 id 在 catalog 面（provider 表、AUTH_PROBE_PIN、ANTHROPIC_SUB_DEFAULT_MODEL、OPENAI_ASTRA_MODEL_ID）。

## 3. 两个尺子场景复量

同一假设改动应用到 base 和 head 的 `git archive` 树，`diff -rq` 计数（`ruler.txt`）：

| 场景 | base | head |
|---|---:|---:|
| A 现有 lane 加一个 provider key 变量（providers.ts + server/env.ts + .env.example） | 3 文件 | 3 文件 |
| B 换一个任务专用默认（QuestionAdmissionAdjudicateTask） | 1 文件 | 1 文件 |
| C 换全局任务默认 | 1 文件（`src/ai/task-spec.ts`） | 1 文件（`src/core/config/model-overrides.ts`） |

## 4. 浏览器 / migrate bundle 不带入新东西

外置盘上重跑 `build` 的五个底层命令（`vite build --config server/start/vite.config.ts` + 四个 esbuild；与 `package.json` 参数逐字相同），base/head 各一遍，全部 exit 0（`bundle-compare.txt`）：

- `dist` 各 756 文件；751 个 SHA256 相同。
- 不同的 5 个：`migrate.cjs`、`server.cjs`、`worker.cjs`、`start/server/server.js`、`_tanstack-start-manifest_v-*.js`。
- esbuild 模块集合逐 bundle 相同：migrate 7580/7580、server 8419/8419、worker 8326/8326、start server 43/43。
- 浏览器侧 333 个 client asset 字节相同；manifest 内容在把两棵树根替换成 `<BUILD>` 后字节相同（唯一差异是生成的绝对路径）。
- migrate 在 base 里本来就含 `model-overrides`（`task_pair_priority` 5 处、`deepseek-v4.1-flash` 10 处，head 同数）；本片只把常量从 `task-spec.ts` 挪到 `model-overrides.ts`，模块集合不变，产物差异来自常量位置与 esbuild 模块顺序（+62 bytes）。

## 5. 门

在外置 head 树执行（`GIT_DIR` 指回 worktree；pnpm deps-status 在导出目录不可用，沿用 slice5 先例直接跑底层命令）：

- `tsrs --noEmit`、`tsrs --noEmit -p server/start/tsconfig.json`：exit 0。
- `biome check .`：2964 files，81 warnings / 0 errors / 0 infos。
- `node scripts/ci/lint-ratchet.mjs --base 4497ab0bb...`：`OK: 81 warnings / 0 infos within base 4497ab0bbda8 count 81 / 0`。
- `audit:model-source --base 4497ab0bb...`：`OK ... 113 derived model ids; 22 literals grandfathered ... none new`。
- `audit:flags --strict`：exit 0。
- `audit:capability-boundaries`：`new dependency edges=0`。
- `audit:architecture-deepening`：passed（57 owned TaskSpecs；dependency totals 195/0/1；pass-through 1249 +0）。
- `audit:schema`、`audit:partition`、`audit:provider-lanes`、`audit:profile`、`audit:task-census`（58 registered / 56 invoked / 2 compat）、`audit:draft-status`：exit 0。

## 没验证的

- `audit:api-client` 未跑成：外置树的克隆依赖缺 `openapi-typescript`，且 `pnpm gen:api-client` 在导出目录触发 deps-status purge；本片没有任何 API route/schema 改动（`git diff` 为空），生成的 client 未变（before/after SHA256 都是 `8a47a78e...`）。
- 未跑完整 `pnpm test`（exact-head CI Gate 负责）；本片是纯搬，58 任务真实 catalog 解析已逐字节对照。
- 未调模型，未连 TEST，未起 server/worker 运行时。
- 未验证 CI 的完整 lane 结果；PR head 的 exact-head `CI Gate` 以 GitHub 为准。
