# YUK-1571 — asset-store 兼容出口退出（交付记录）

协调线批准的限定切片：已归 `src/kernel/records/asset-store.ts` 的完整
`source_asset` 写协议本体不改，本片把所有真实 consumer 的 import 直指真身，
并彻底删除 `ingestion/server/persist-image-asset.ts` 的六个临时运行转出与
`practice/.../jyeoo-candidates.ts` 的 `lockImageStorageKey` 旧转出；同时删除
`ingestion/public.ts` barrel 上三个同名运行转出（已证零真实 consumer）。
批准出处：
<https://linear.app/yukoval-studios/issue/YUK-1571#comment-03dae10a-ad31-4219-800f-2e79b948937a>
（7 站点 compatShims 于 UTC 2026-10-20 合入，deadline 2026-11-03，不续期）。
抓取、供给、paid、provider、预算、检索、时序行为不在本片；kernel 实现、
测试用例/数据/断言、audit 逻辑、schema、CI、package/lock 零改动。

## 本片做了什么

1. **消费者直指真身**（8 个 ingestion 文件 + 1 个 DB 测试 +
   1 个 practice job）：`persistSourceAsset`/`persistImageAsset`/
   `deleteImageAsset`/`lockImageStorageKey`/`sha256Hex`/`isUniqueViolation`
   的 named import 从 `ingestion/server/persist-image-asset.ts`（或
   `jyeoo-candidates.ts` 转发）改指 `@/kernel/records/asset-store`。
   同一句混入 `getR2`/`R2Client`/`SourceAssetRow` 的拆 import，这三符号
   保留原路径；其余 bindings、import 顺序（按 Biome 排序位落位）、
   函数体零改动。
2. **临时出口退役**：`persist-image-asset.ts` 删六个 value 转出与随之
   无用的 kernel value import，保留 `getR2`/`R2Client`（r2 接缝旧口）与
   `SourceAssetRow` type 转出；`jyeoo-candidates.ts` 只删
   `lockImageStorageKey` 转出（内部 lock import 仍走 kernel，未动）。
3. **barrel 收窄**：`ingestion/public.ts` 删 `lockImageStorageKey`/
   `persistImageAsset`/`sha256Hex` 三个运行转出；type 与其他 public 不动。

调用方少知道一层临时中转——import 直接指向拥有协议的模块；调用处
参数、返回形态与执行步骤逐语句不变。本片是临时调用路径消除，不称
新算法或 SCC 收益。

## 消费者核对（13 路径 + 保留接缝）

| 文件 | 改指符号 | 备注 |
|---|---|---|
| ingestion/api/assets.ts | persistImageAsset | getR2 原 `@/server/r2` 不动 |
| ingestion/api/pdf.ts | persistImageAsset | 同上 |
| ingestion/api/asset-delete.ts | deleteImageAsset | 同上 |
| ingestion/api/assets.db.test.ts | persistImageAsset | 仅 import 路径（协调已批）；用例/数据/断言不动 |
| ingestion/server/docx/persist-page-evidence.ts | persistImageAsset, persistSourceAsset | R2Client 原 `@/server/r2` 不动 |
| ingestion/server/source-package.ts | persistSourceAsset, sha256Hex | R2Client/SourceAssetRow 拆句留旧路径 |
| ingestion/server/tools/media-tools.ts | isUniqueViolation, persistSourceAsset | SourceAssetRow 拆句留旧路径 |
| ingestion/server/image-candidate-accept.ts | persistImageAsset | getR2/R2Client 原 `@/server/r2` 不动 |
| ingestion/server/crop.ts | isUniqueViolation, lockImageStorageKey, sha256Hex | SourceAssetRow 拆句留旧路径 |
| ingestion/public.ts | （删三个运行转出） | 零真实 consumer 已证；type 保留 |
| ingestion/server/persist-image-asset.ts | （删六个 value 转出） | getR2/R2Client/SourceAssetRow(type) 保留 |
| practice/jobs/jyeoo_staged_asset_reap.ts | lockImageStorageKey | JyeooR2Client/resolveJyeooR2 原路径不动 |
| practice/server/question-supply/jyeoo-candidates.ts | （删 lockImageStorageKey 转出） | 内部 kernel import 保留 |

保留接缝的反向核对：`source-tool-support.ts` 仍经旧口取
`getR2`/`R2Client`/`SourceAssetRow`——该文件未进 13 路径，因为其消费的
三个符号全部在保留面内，零改动即满足。

## 全渠道 consumer 核查（删除前在最新 main 实测）

- `persist-image-asset` 模块引用：全部命中即 13 路径内文件 +
  `source-tool-support.ts`（只用保留三符号）。docs / baseline 文本命中
  不计为代码 consumer。
- `ingestion/public` barrel 全部 importers（`src/server/session/
  docx-ingestion.ts`、`src/server/records/*`、`server/start/*`、
  `proposals/action-types.ts`、`admin-config-facts.ts`）逐一核符号：
  无一引用 `lockImageStorageKey`/`persistImageAsset`/`sha256Hex`。
- `jyeoo-candidates` `lockImageStorageKey` 转出唯一 consumer =
  `jyeoo_staged_asset_reap.ts`（已在 13 路径内改指 kernel）。
- 无 dynamic `import()`、namespace `import * as`、`export *`、require
  通道指向两个 shim 模块；同名异实现（copilot/judge-calibration/
  route-classify 等的本地 `isUniqueViolation`/`sha256Hex`）与 shim 无
  import 关系，非 consumer。
- 13 路径之外未发现新的真实 consumer，无需上报扩写。

## 台账与站点

- `compatShims` 7 条原样保留为 append-only 批准历史（不删、不续期）；
  其站点在 head 已不存在 → audit 按 `!live → continue` 跳过，目标
  「7 live sites = 0」达成方式是删除站点本身，不是洗历史。
- `edgeRecords` 追加 9 条 `capabilityToKernel` 登记（file→module→
  实际消费 symbols 逐条对齐；`assets.db.test.ts` 在扫描 TEST_RE 排除面
  内，不产生被审计边，不登记）。
- 三个 debt 计数器零移动：capability→server（r2 接缝边原样）、
  server→capability-deep、cross-capability-value（reap 为 practice
  同包边）均不变，无 decrease，不走 `--tighten`。
- `export { getR2 }`（persist-image-asset）与 `export { getR2 as
  resolveJyeooR2 }`/`export type { R2Client as JyeooR2Client }`
  （jyeoo-candidates）保持原形态，`site|local-export` 身份与 base
  相同——base stock，未生成新站点。
- `notes` 旧条目（含 capability→server 406 历史计数）按规则保留不改。

## 机器门真实结果

依赖由父 heavy.sh frozen install 就位（exit 0，lock 未动）后，本树按
串行 heavy.sh 实测（全机 ≤2）：

- `pnpm typecheck`：PASS（tsc 双跑 exit 0）。
- `pnpm lint`（`biome check .` 项目 pin）：PASS——2510 文件 0 error，
  180 warning 全部为存量上游（本片 0 新增）；error-only 复查干净。
- `pnpm build`：PASS（web dist + server/worker/migrate 三 esbuild 产物，
  仅存量 INEFFECTIVE_DYNAMIC_IMPORT 提示）。
- `pnpm audit:capability-boundaries`：PASS——debt 精确 405/0/39，
  **new dependency edges = 9**（恰为本片登记的 9 条 capabilityToKernel），
  server-entry 新边 0，非平凡 SCC 1（base 1）。
- `pnpm audit:architecture-deepening`：PASS——dependency totals
  405/0/39 低于 531/70/62；**pass-through sites 1090（+0 new）**——
  7 个退役站点在 head 消失，7 条 compatShims 记录 non-live → continue，
  台账原样保留。
- NOT_RUN：全部 vitest 分区 / DB / Docker / daemon / provider /
  runtime（测试不在本机 gate；由 push 后 exact-head CI Gate 执行）。

## Revision / 外部路径

- base：`origin/main` `b4dad2914308e2acf73de1086bb72877ce4eb91a`（#1905，
  自最新 origin/main 起，非父 local）。
- branch：`arch/asset-compat-exit`；本地提交，不 push / 不开 PR。
- 证据外置：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/
  architecture-deepening/YUK-1571/<fullhead>/`（exact-head 实测清单、
  consumer 核查输出、机器门结果与 NOT_RUN 登记表）。
