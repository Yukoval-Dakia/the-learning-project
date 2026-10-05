# YUK-910 — TypeScript 7.0 迁移评估报告

Date: 2026-09-23 · Branch: `yuk-910-ts7-eval` · Base: `origin/main @ a1e563136`
Ticket: YUK-910（[Tooling] TypeScript 5.9 → 7.0 主版本迁移评估，dependabot #1232 关闭后的迁移轨）

## 结论（TL;DR）

**决策：上 —— 但迁移在 main 上早已完成，本票无需任何代码/依赖变更。**

`pnpm typecheck` 当前解析到 `tsc@7.0.2`（Go-native compiler），即 dependabot #1232
想要升到的同一个版本。仓库实际路径是 `5.9.x → tsgo preview → 7.0.1-rc → 7.0.2`，
由 YUK-504 与 YUK-823 两票完成。#1232 的 4 个 CI fail 是 stale base 噪声
（其基点假设仓库还在 5.9.3），按 dependabot 噪声规则关闭是正确的；
本票作为迁移轨复核，确认迁移既成事实且全闸门绿。

## 现状盘点（origin/main 实测）

| 项 | 值 | 来源 |
| --- | --- | --- |
| `pnpm exec tsc --version` | `7.0.2` | `@typescript/native = npm:typescript@7.0.2`（package.json:178） |
| `pnpm exec tsc6 --version` | `6.0.3` | `typescript = npm:@typescript/typescript6@6.0.2`（package.json:188；wrapper 包 6.0.2 内嵌 compiler 6.0.3） |
| `typescript` JS API（`ts.version`） | `6.0.3` | 6 个 audit/task-census 脚本 + 传递 peer（如 `@qdrant/js-client-rest`） |
| `typecheck` | `tsc --noEmit`（TS7 native） | package.json:20 |
| `typecheck:legacy` | `tsc6 --noEmit --incremental false --stableTypeOrdering` | TS6 逃生舱；`--incremental false` 防止旧格式 buildinfo 污染 TS7 cache |
| `typecheck:watch` | `tsc --noEmit --watch`（native watcher） | YUK-823 新增 |
| CI Gate static lane | `pnpm typecheck` + `tsconfig.tsbuildinfo` cache | `.github/workflows/ci-gate.yml`（key 按 lockfile+tsconfig hash 隔离） |
| npm dist-tags | `latest=7.0.2`，`rc=7.0.1-rc`，`next=7.1.0-dev.*` | 7.0.2 即最新 stable；7.1.0 仅 dev nightly，不符合 ≥7 天 stable 选取规则 |

## 迁移历史（实际路径）

1. `ceb5a4163` YUK-504（2026-06-27, #625）：`typecheck` 切到 tsgo
   （`@typescript/native-preview`），保留 `typecheck:legacy`=tsc 与
   typescript@5.9 供 IDE/tsx/drizzle-kit；实测 cold 34.8s→4.0s（~8.7x），
   诊断零 delta（含注入 TS2322 byte-for-byte 对照）。
2. `3d184406c`（2026-06-28）：tsgo preview 毕业 → released `typescript@7.0.1-rc`
   的 native `tsc`；`tsgo --noEmit` → `tsc --noEmit`，CI 无直接 tsgo 引用。
3. `c4c26c764` YUK-823（2026-07-29, #1112/#1113）：GA 收口——
   `@typescript/native = npm:typescript@7.0.2` 提供 native `tsc`；
   `typescript = npm:@typescript/typescript6@6.0.2` 恢复完整 JS compiler API +
   `tsc6`；CI 缓存 `tsconfig.tsbuildinfo`；实测 TS7 全量 5.73s vs TS6 33.41s
   （5.83x），warm buildinfo 0.584s（9.12x），`--checkers` 默认≈4 最优。
4. dependabot #1232（2026-08-16 关闭）：5.9.3→7.0.2 PR 基于 stale base，
   4 fails 属冲突噪声，按规则关闭——本票为其迁移轨复核票。

## 破坏性变更盘点（对照 TS7 迁移面）

| 类别 | 仓库现状 | 判定 |
| --- | --- | --- |
| tsconfig 废弃 flag | `tsconfig.json` 未使用任何 TS6 起废弃/TS7 移除项（无 `out`、`charset`、`importsNotUsedAsValues`、`preserveValueImports`、`suppressExcessPropertyErrors`、`amd/umd/system` module、`<ES2015` target）；`target: ES2022` / `module: esnext` / `moduleResolution: bundler` / `jsx: preserve` / `strict` / `incremental` 全部兼容 | 无改动需求 |
| 模块解析语义 | `moduleResolution: bundler` + `@/*` paths，TS7 语义不变 | 无改动需求 |
| 类型检查行为 | YUK-504/823 均记录 clean tree 零诊断 delta；本 worktree `tsc@7.0.2` 实测 0 errors | 无回归 |
| Go-native toolchain 集成 | `tsc` 为 native binary（平台 optional deps 分发，如 darwin-arm64），CI/本机均走同一 `pnpm typecheck`，无新 runtime；esbuild/vite/tsx/vitest 不经 `tsc` emit，emit/decorator/plugin gap 不在关键路径（YUK-504 已论证）；Dockerfile build 不跑 typecheck | 无新 runtime 需求 |
| `typescript` JS API | TS7 native 无对等 JS API → `typescript` 包名固定在 typescript6（JS 最后一条 API 线）供 6 个 `import ts from 'typescript'` 脚本与传递 peer；`tsc6` 作 `typecheck:legacy` | 已正确隔离 |
| IDE / editor | 无 `.vscode/settings.json` workspace pinning；编辑器自带 TS 版本低于 7 时本地诊断可能与 CLI 不一致（仅体验差异，非 gate） | 低 |

## 本票闸门实测（worktree，exact head `a1e563136`）

| Gate | 结果 |
| --- | --- |
| `pnpm typecheck`（tsc 7.0.2） | **0 errors**，wall 15.5s（cold） |
| `pnpm lint`（biome check） | exit 0；2562 files，306 warnings 为既有 ratchet 基线，0 errors |
| `pnpm build` | exit 0：vite SPA + esbuild `dist/{server,worker,migrate}.cjs`（28.0/28.1/8.4 MB） |
| scoped unit `vitest run src/core/` | **85 files / 1329 tests passed**，6 skipped（pre-existing skip） |
| 新增 `@ts-ignore` / `as any` | 0（无任何代码变更） |

完整 test gate（unit/db/migration 全量 + audits 链）按仓库约束只由 push 后
exact-head `CI Gate` 执行；本 PR 为 docs-only。

## 决策与理由

**上（维持 TS7，无变更）。** 迁移目标版本（7.0.2）已在 main 稳定运行约两个月，
本地闸门与 CI Gate 长期绿色；再次「迁移」无对象。本票以文档形式封存评估证据，
等价于 acceptance 全部满足（TS7 全仓 typecheck 通过、无新增 suppress、决策已记录）。

## 剩余风险与 follow-up

- `typescript`（API 线）冻结在 typescript6 6.0.2（内嵌 6.0.3）：若 audit/task-census
  脚本将来需要新 lib.d.ts 或新 AST，需另立票评估 API 侧升级或转 Language Service。
- 7.1.0 目前仅 dev nightly；下一个 stable minor 走常规 dependabot/小票轨，无需 epic。
- `tsc`（7.0.2 native）与 `tsc6`（6.0.3 JS）双 bin 共存依赖 pnpm bin link；当前解析正确，
  若未来 bin 名冲突需重查 `.bin` 解析顺序。
- 编辑器自带 TS <7 的本地诊断差异：可选 follow-up（workspace version pin 或文档提示），非阻塞。
- dependabot 主版本 PR 在 alias 依赖结构下必然 stale-base：建议后续在 dependabot
  config 中对 `typescript` 族加 ignore 或改用 grouped/cooldown 策略（可立小票）。

## 参考

- `git log`：`ceb5a4163`（YUK-504）、`3d184406c`（7.0.1-rc）、`c4c26c764`/`766351a53`（YUK-823, #1112/#1113）
- `.remember/now.md` @ `c4c26c764`：YUK-823 性能对照原始数据
- `.github/workflows/ci-gate.yml` static lane：typecheck + tsbuildinfo cache
