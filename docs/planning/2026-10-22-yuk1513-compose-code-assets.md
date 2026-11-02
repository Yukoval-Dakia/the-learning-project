# 录入助手保存自定义块代码资产

2026-10-22。YUK-1513 / K5「第一天能用」的独立第一片，服务于展示契约的真实资产生产。初次交付基线为 `1af581d1fffb74ba667e4eb63c1a08b83ed55d4e`，交付 head 为 `2b9a02adf5add0096eea758f0b3cc72959f6582d`。R1-01 修复前正常 merge fresh main `3136a7bd994dc8ce58f9c745b6455b0e787c4b4a`，merge commit 为 `78e93709ce9df0ced8662bae9ba9389b217c713d`：纳入两个上游提交、12 文件（199 增 / 13 删），无冲突；唯一 owned 交集为 baseline 的两条已批 stable contract 与一条 source-size 记录，完整保留。本片其它产品路径无上游差量。

授权来源：YUK-1513 原描述与协调线已读的五条评论；`/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/custom-block-sandbox-plan.md` 修订版 v2；[展示 spec §1.3、§1.3.2、§5](../design/2026-10-16-presentation-spec-v1.md)。网页前置 YUK-1519 已完成，本片不改网页宿主。

## 实际生产链

现役 `IngestionAgentTask` 已通过 ingestion manifest 挂载 `compose_presentation`。本片扩展同一工具的顶层 object，保留无 action 的原模式，未增加工具、路由或注册表。

1. R8 用 `edit_question` 建立系统盖章的 v2 草稿并取得当前 `draft_ref`。
2. 必须使用代码时，调用 `compose_presentation({action:"write_custom_code", draft_ref, code})`。代码模式只接收这三个字段；拒绝模型供应 asset_id、digest、mime、归属或与 presentation 写入混用的参数。
3. 服务端校验当前 ingestion scope 与 `ingestion_agent:<session>` actor 一致；在持有 share 行锁时确认 ingestion session 仍为 extracting、草稿仍属 `draft:<actor>`、版本相符且是该 actor 的合法系统盖章 v2 文档。无任意 session/actor 写入口。
4. 代码编码为 UTF-8，只接受 1..262144 字节，复用 `findCustomCodeForbiddenSequence` 拒绝 script 关闭、HTML 注释起始与 NUL。只处理字节，不 eval、import 或执行代码。
5. kernel asset-store 从实际字节计算 SHA-256，复用 `customAssetIdForDigest` 产生 `sbx_` 加前 32 hex 的 id；mime 固定 `text/javascript`，kind 为 text。完整持久化事务提交后才返回 `custom_code_saved`、`asset_id`、`digest`、`byte_size`、`mime` 与 `reused`。
6. R8 把返回的真实引用放进 custom block 的 `sandbox.asset`，继续原 presentation 保存链。代码保存不改变草稿版本；presentation 保存仍只修改 presentation，通过原事件 owner 执行版本 CAS、request replay、同版 v2 转换与绑定校验。后续提交仍使用 presentation 保存返回的新草稿身份；revision 仍只读。

代码回执明确为 `preview=not_run`、`serving=withheld`。`reused` 只表示已核验并复用了同一内容资产，不是 presentation 的 request replay 回执。无 action 的模式拒绝 code，不会悄悄写代码。未知 action/额外身份字段明确拒绝；不能把未知草稿声明吞掉再落 legacy。

## 不可变存储与恢复

`persistImmutableCustomCodeAsset` 是绑定上述 live consumer 的完整操作。调用方只提供 bytes、服务端 provenance 和事务内授权回调，不自行编排存储锁、blob 写入或 owner row。

- 存储键为 `assets/custom-code/<完整sha256>`，与旧 source/image 无条件 put 的默认命名空间分开。共用既有 storage-key advisory lock 协议，授权行锁、存储锁与 owner row 提交处于同一事务。
- 新对象只经 `putIfAbsent` 写入。R2 的实现发送 S3 `PutObject` 的 `IfNoneMatch: '*'`；仅 HTTP 412 表示对象已存在，仍须读取和逐字节比对。其它错误（含 409、不支持条件写、网络不确定）失败，不回退 put。
- 旧 blob 客户端接口保持兼容，新方法可选；缺少该能力的客户端明确 fail-closed。原 put/get/delete 与凭据逻辑不变。
- 旧行先核实 id、完整 SHA、存储键、kind、mime、字节数、空图像尺寸与 custom-code 来源标记，并拒绝同键的其他逻辑 owner。旧行重放不 put、不 insert，仍读取并核实完整字节。缺失旧 blob 不自动修复。
- 新行使用 `INSERT ... ON CONFLICT DO NOTHING`，随后重读并严格核实身份；截断 id 碰撞、错误元数据或字节不一致都拒绝，不覆盖原行/对象。不同 session 提交相同字节复用同一全局内容资产，保留首个 writer 的 provenance，不增加逻辑行或改归属。
- 共享单行不能作为旧删除协议的一份引用 owner。通用删除 owner 持 storage-key 锁并重读真实行后，对 `provenance.source_kind=custom_block_code` 或 `assets/custom-code/` 保留命名空间明确抛出 `ImmutableAssetDeleteForbiddenError`；拒绝发生在 blob/row 的任何删除之前。真实 `DELETE /api/assets/[id]` 映射为 HTTP 409，返回稳定错误码 `immutable_asset_delete_forbidden` 和可读原因，保留所有 session 已保存的引用。不存在仍为 404，普通 source/image 的 owner 查询、blob/row 删除 body 与顺序保持。
- blob 成功而事务失败/提交结果未知时，保留不可变对象；不做补偿删除。重试只能通过条件创建与完整字节核验恢复孤立对象，再登记 owner row。旧行存在但字节不可读、冲突或未知 DB 提交均不签发成功引用。失败候选可能留下无 owner 的对象，本片不增加回收器，也不误删其他 owner 对象。

条件写依据：[Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) 明确条件在对象提交时原子求值；[Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) 定义 If-None-Match 与 412/409 的语义。这里只核对文档与 SDK 类型，未对存储服务做运行验证。

## 边界与剩余义务

现有 `persistSourceAsset`、`persistImageAsset` 的写入行为与普通 source/image 删除能力保持。新增共享代码资产沿不具引用语义的旧通用删除被明确禁止，不新建引用表、registry、回收器或路由；未来删除需要在 YUK-1513 明确引用生命周期后再开放，当前保留对象。本片不修改 capability→server/cross-capability 边、不增加 re-export/兼容层，也不放宽任何 audit/baseline 分类。原片 baseline 仅追加私有 operation → kernel asset-store 的真实 value edgeRecord；修复 API 在既有 kernel import 边消费领域错误，不新增依赖边或自签分类。上游及原片记录完整保留。

无头浏览器预演、资源限制和每个 bind 的合法信封证明，所有 publisher 的 `readAssetBytes` 接线、网页/serving 放行和真实 provider 录入验收仍属于 YUK-1513 后续片。现有发布缺 reader 的 fail-closed 与 custom serving withheld 保持。本片没有完成预演、代码安全证明、发布或可练验收，不能据此关闭整张 YUK-1513。

## R1-01 修复与证据边界

完整报告：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1513-code-assets-20261022/pr1994-r1-2b9a02ad.md`，CHANGES_REQUESTED，新 P0/P1=0/1；父线已接受该 P1。触发为 A/B session 保存同字节并共用一行，旧 DELETE 仅检查同键不同 id 的 owner，会删除唯一行/blob，令 B 的草稿 ref 悬空；无需 preview 或 serving 放行。

本修复只在原 kernel 删除 owner 的锁内活行重读后拒绝上述类别，并在真实 DELETE 边界映射 409。manifest 已展开的 `API_ERROR_RESPONSES` 包含 409，因此不改 manifest；同步 Postman API 说明并运行现有生成命令。没有把旧不存在/成功语义挪用于拒绝结果。

R1 只覆盖 `2b9a02ad`；原 GitHub CI 或首交静态检查不覆盖 merge 后的新组合。修后独立 R2 与最终 exact-head CI 由父线负责；本片仍未交付无头预演，不能据修复声称预演、发布或可练已完成。本轮新组合静态检查回执另列，未运行 DELETE/DB/对象存储场景。

## 首交验证记录（仅原固定 head）

所有本机重活经 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh` 串行执行，本线并发 1、全机上限 2，`NODE_OPTIONS=--max-old-space-size=3072`。最终命令另带 `pnpm_config_verify_deps_before_run=warn`，避免 pnpm 因复制依赖内的原工作区绝对 patch 路径而自动安装；未修改任何仓库配置。原 lockfile、已安装 lockfile 和 mem0 patch 分别用 cmp 确认字节相同。最终依赖为本隔离树内的 `cp -cR` 文件副本，不向来源工作树写入。

原日志根：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/yuk1513-compose-code-assets-20261022/`。下列回执仅绑定首次交付的 `2b9a02ad`，不覆盖后续 merge 与 R1-01 修复：

- `pnpm typecheck`：exit 0，`typecheck-r3.log`（含 Start tsconfig）。
- `pnpm lint`：exit 0，181 个仓库 warnings，`lint-r2.log`；本片五个产品文件的 Biome 检查无 warnings。
- `pnpm build`：exit 0，`build-r2.log`（SPA、Start、server、worker、migrate 均完成；保留 bundle 大小、既有动态导入与 inputValidator 弃用警告）。
- `pnpm audit:tool-params`：exit 0，`tool-params.log`；包括 ingestion 19 个真实挂载工具，root object 无违规。
- `pnpm audit:schema`：exit 0，`schema.log`；1057 字段，无未许可 stub。
- `pnpm audit:capability-boundaries --base 1af581d1fffb74ba667e4eb63c1a08b83ed55d4e`：exit 0，`capability-boundaries-r2.log`；384/0/36 债务不增长，新边恰为已登记的 1 条，无新 server-entry 边。
- `pnpm audit:architecture-deepening --base 1af581d1fffb74ba667e4eb63c1a08b83ed55d4e`：exit 0，`architecture-deepening.log`；59 owned DomainTools、58 owned TaskSpecs、无新增 pass-through。
- `pnpm audit:question-writers`、`pnpm audit:structured-judge`、`pnpm audit:draft-status`、`pnpm audit:draft-status-reads --strict`：均 exit 0，分别为 `question-writers.log`、`structured-judge.log`、`draft-status.log`、`draft-status-reads.log`。
- `git diff --cached --check`：exit 0；五个产品文件均低于 500 行。

真实首轮失败原样保留：`typecheck.log` exit 1，借用 node_modules 的 pnpm 自动依赖修复在编译前因无 TTY 中止（未移除依赖、无成功安装）；随后改为本树独立副本。`lint.log` exit 1，3 个本片格式错误，已由现有 Biome 修正（`biome-owned-fix.log` exit 0，修正三文件）。`capability-boundaries.log` exit 1，仅新 kernel 消费边缺登记，报告协调线后追加上述唯一记录。`dependency-copy.log` exit 0；初次 `build.log`、`typecheck-r2.log` 也为 exit 0，但最终以最新基线的 r2/r3 日志为准。依赖路径 warning 保留，不伪称执行过 frozen install。

严格 NOT_RUN：测试编写/修改/执行、断言脚本、DB、TEST、Docker、daemon、provider、浏览器、产品 runtime、付费操作、部署；未执行任何不可信 JS。独立审查、exact-head CI 与后续实际验收由父线负责；child 完成不等于父验收。Linear capture 搜索 `YUK-1513` 命中原票，预演/发布 reader/serving 与真实验收义务已由原票覆盖，无新独立 actionable follow-up，不另开票，YUK-1513 仍 In Progress。

## R1-01 修后新组合静态回执

本轮对象为上述 `3136a7bd` main + 原片 + 删除保护修复；没有用原 head 的 CI 绿替代新组合验证。R1 修复 delta 只含 kernel 删除 owner、真实 asset-delete API、Postman spec/生成物与本文五个文件；普通 merge 的上游十二文件另列，不是本轮重写。baseline 相对新 main 仍只有原片的那一条真实 edgeRecord，本轮没有新增或改写 baseline 分类。manifest 无 delta。

日志目录：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/yuk1513-compose-code-assets-20261022/r1-fix/`。全部重活继续使用上述 heavy.sh、Node≤3072 MiB、`pnpm_config_verify_deps_before_run=warn`，本线串行；没有安装依赖或修改 lock。

- `pnpm typecheck`：exit 0，`typecheck.log`。
- `pnpm lint`：exit 0，181 warnings，`lint.log`；改动产品文件/规范的现有 Biome 检查 exit 0，`biome-owned.log`（只修正 API import 的格式）。
- `pnpm build`：exit 0，`build.log`，SPA/Start/server/worker/migrate 全部完成；既有 bundle、动态导入与 inputValidator 警告保留。
- `pnpm gen:postman`：exit 0，`gen-postman.log`，37 folders / 100 paths / 108 requests；生成物有 25 行真实增量，仅新增既有 DELETE 的说明条目，没有手改 collection 或新增路由。
- `pnpm audit:api-contracts`：exit 0，`api-contracts.log`，165/165 declared、0 legacy、155 OpenAPI paths。
- `pnpm audit:api-client`：最终 exit 0，`api-client-r2.log`，生成的 `src/ui/lib/api-schema.generated.ts` 无 delta。首次 `api-client.log` exit 1 原样保留：本树缺 `tools/api-codegen/node_modules/openapi-typescript` 工作区链接；只将该工具的两个包链接到本树已有 `.pnpm` 版本（openapi-typescript 7.13.0、TypeScript 5.9.3），未向其他树写入、未安装或改锁。
- `pnpm audit:schema`：exit 0，`schema.log`，1057 字段、无未许可 stub。
- `pnpm audit:capability-boundaries --base 3136a7bd994dc8ce58f9c745b6455b0e787c4b4a`：exit 0，`capability-boundaries.log`，384/0/36 债务不增长，新边仍只有原片已登记的 1 条。
- `pnpm audit:architecture-deepening --base 3136a7bd994dc8ce58f9c745b6455b0e787c4b4a`：exit 0，`architecture-deepening.log`，无新增 pass-through。
- `git diff --check`：exit 0；未新增/修改测试或断言脚本，未重复无关门。

上述为源码与本机静态/生成检查，未直接运行 DELETE、共享 A/B session、DB 或对象存储，不构成实际并发/保留行为验收。修后独立 R2 和最终 exact-head CI 仍归父线；本 child 不 watch/poll/merge/resolve。Linear capture 搜索命中原 YUK-1513，本轮唯一 R1-01 在原票范围直接修复，无新增独立 follow-up，不另开票；原票后续预演与生命周期义务仍未交。
