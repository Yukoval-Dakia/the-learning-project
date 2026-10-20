# YUK-1571 — 共享 source_asset 持久化协议归 kernel/records（交付记录）

协调线批准的限定切片：ingestion 与 practice jyeoo 供给链实际共享同一
内容寻址 `source_asset` 写协议（同一对象键 advisory 锁与行生命周期），
协议整体由 `ingestion/server/persist-image-asset.ts` 迁入
`src/kernel/records/asset-store.ts`。纯搬迁，无运行时 registry/DI/新机制；
抓取、供给、paid、检索行为不在本片。批准出处：
<https://linear.app/yukoval-studios/issue/YUK-1571#comment-03dae10a-ad31-4219-800f-2e79b948937a>
（提案 `docs/planning/2026-10-21-shared-asset-protocol-cut-proposal.md`）。

## 协议责任（kernel 模块 owns 什么）

`src/kernel/records/asset-store.ts` 承载完整机制：字节视图 sha256 →
`assets/<sha>` 内容寻址键 → 同键 advisory 锁自持锁到 owner 行提交（闭合
「对象已传、owner 行不可见」窗口）→ 可选尺寸读取（sharp lazy import，
不识别的格式保持 null 维度）→ `source_asset` INSERT（kind/provenance/
字节数/尺寸元数据）→ INSERT 失败时按持锁期 owner 快照补偿 `r2.delete` →
`deleteImageAsset` 末位 owner 判定 + 锁后新鲜重读再删对象与行。
`AssetBlobClient { put; delete }` 是结构化参数契约，`R2Client` 可赋值；
`getR2`/`R2Client` 保留原 `@/server/r2` 接缝不进 kernel。
kind/provenance 是 caller 自带词表，kernel 只承载机制不吸收语义。

## 两个现有 live 域

1. ingestion 各路径（api assets/pdf/asset-delete、crop、source-package、
   docx/persist-page-evidence、image-candidate-accept、media-tools、
   source-tool-support、`ingestion/public.ts` barrel）——全部经
   `persist-image-asset.ts` 的兼容转出零改动。
2. practice jyeoo 供给链（`jyeoo-candidates.ts` staged 资产持久化 +
   `jyeoo_staged_asset_reap.ts` 经其转发的同键锁）——直接消费 kernel 模块。

不以「第三 capability 未来消费」论证共享；两个 live 域即足够。

## 五条判定核对（按本次裁定语言）

1. **完整职责归属**：kernel 模块 owns 整条「字节 → 对象 → owner 行 →
   末位回收」协议，含锁序、事务、补偿与失败语义——不是 facade 或图转接。
2. **caller 知识收敛**：practice 不再为共享存储协议认识 ingestion 的
   公共 barrel；台账「ingestion owner」实为托管位置的事实修正。
3. **真实共享写件**：两域 live consumer 已在用同一锁与行生命周期，
   不是按纯函数或目录名论证 kernel。
4. **无新框架/非转发**：零运行时新机制；转出仅指向真身的同名符号，
   不用 wrapper 顶替完整职责。
5. **行为保持**：迁移体逐语句等价（锁序、补偿、失败面、注释原样）；
   测试与 `ingestion/public.ts` 字节不变。

## 两个真实变化场景

1. 新增资产 kind / 新格式尺寸识别：前后都改同一实现体；变化只是归属
   诚实（改「共享件」而非「ingestion 文件」）。不夸大 locality。
2. 协议演化（如 staged-reap 语义、新生命周期规则）：Before 需在 ingestion
   业务域里改一件与其域决策无关的机制并担心误伤域内不变量；After 在
   kernel 改机制，kind/provenance 词表仍由各 caller 参数自带，权责与
   修改面一致。

## 非新算法深度声明

接口/调用步骤与维护场景修改文件数基本不变；本片是归属修正与图边消除，
不称新增算法深度。预计图变化（cross 40→39、SCC 4→3 {agency,knowledge,
practice}、capability→server 406 不变）已按现有 audit 口径登记进
`scripts/capability-boundary-baseline.json`，以 audit 实测为准。

## 授权原话（批准范围）

- 共享 `source_asset` 内容寻址写入/删除完整协议归
  `src/kernel/records/asset-store.ts`；
- `ingestion/server/persist-image-asset.ts` 转出
  `persistSourceAsset`/`persistImageAsset`/`deleteImageAsset`/
  `lockImageStorageKey`/`sha256Hex`/`isUniqueViolation` 六个运行符号到
  kernel 同名真身；
- `jyeoo-candidates.ts` 的 `lockImageStorageKey` 旧转出改 kernel；
- `getR2`/`R2Client` 保留原接缝；`SourceAssetRow` 类型保留兼容；
- 测试本实施 PR 一字不动；`persistImageAsset` 旧路径测试绑定只有
  owner 另行批准文本方案后才能改指。

## Compat 退出清单（deadline UTC 2026-11-03，不续期）

`compatShims` 台账 7 条，逐 symbol + targetModule 精确绑定，窗口自
UTC 合入日起算、最迟 2026-11-03。退出动作（另片原子删，需消费者确认）：

| shim 文件 | 符号 | 退出动作 |
|---|---|---|
| ingestion/server/persist-image-asset.ts | persistSourceAsset | docx/persist-page-evidence、source-package、media-tools 改指 kernel 后删转出 |
| 同上 | persistImageAsset | api/assets、api/pdf、image-candidate-accept、docx/persist-page-evidence、ingestion/public 改指后删转出；assets.db.test 绑定须 owner 另行批准文本方案 |
| 同上 | deleteImageAsset | api/asset-delete 改指后删转出 |
| 同上 | lockImageStorageKey | crop、ingestion/public 改指后删转出 |
| 同上 | sha256Hex | crop、source-package、ingestion/public 改指后删转出 |
| 同上 | isUniqueViolation | crop、media-tools 改指后删转出 |
| practice/.../jyeoo-candidates.ts | lockImageStorageKey | jyeoo_staged_asset_reap 改指 kernel 后删转出 |

`getR2`/`R2Client` 转出不在 7 条内：保留原 `import`+`export {}` 形态后其
pass-through 站点身份与 base 相同（`site|local-export`），未生成新站点；
若未来 scanner 将其判为新站点，单独报告，不自动扩用本次批准。

## Revision / 外部路径

- base：`origin/main` `6a76a5225`（固定基线，自最新 origin/main 起，非父 local）
- branch：`arch/shared-asset-protocol`（不带票号，避免整票自动关）
- head / worktree：以 `git rev-parse HEAD` 与本 worktree 路径为准
- 证据外置：`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1571/<head>/`
