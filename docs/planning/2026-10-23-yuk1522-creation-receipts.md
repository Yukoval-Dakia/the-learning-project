# 两条创建入口的长期回执与物化失败收口（YUK-1522）

服务阶段：第一天能用；契约根项为 YUK-1522 的创建响应丢失后恢复原身份。
本片交付源码、迁移与静态验证，真实 HTTP、并发、故障、迁移和恢复验收由父线程安排。

## 已批准范围与迁移顺序

持久模型和共享 hunk 已获 owner 批准，采用唯一 LIGHT 方案，不再等待设计审批：

- [YUK-1522 最终批准](https://linear.app/yukoval-studios/issue/YUK-1522#comment-43a6a322-656d-4588-abed-0c1ca5532d3f)。
- [YUK-1448 迁移定序](https://linear.app/yukoval-studios/issue/YUK-1448#comment-7e394fc9-e597-4011-9b10-521a97a4be18)。

批准 TEXT 为仓库外
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-ingestion-budget-history-20261020/creation-receipt-text-a59fe2cf.md`。
其中旧的“尚未批准”和“0133 属于 1969”等待文字已被上述裁定覆盖。

本树从鲜核 `origin/main=8aca535f4b0cf65ac395e792dd6f360408c61267` 开始。提交前主线
前进至 `6d99227eac5e68fe6f27bb90d4175d60b0cb5070`，仅架构登记文件有 owned 交集；
完整保留上游登记后正常 rebase 到该 SHA，最终实现基线为后者。两次主线的迁移末项都是
`0132_yuk1563_custom_providers`，备份版本 `4.32`。本片先交
`0133_yuk1522_ingestion_creation_receipt` 和 `4.33`。snapshot/journal 由实际
Drizzle generator 生成，0133 prevId 指向真实 0132 的
`bc17bd38-072a-4119-9691-d7b20b25e7e4`。不吸收题库表或未合迁移；1969 的旧
0133 保持冻结，待本片实际合入后由父线程另行重生题库 0134，并保留备份版本 4.33。

## 用户可观察的结果

`POST /api/ingestion-sessions` 和 `POST /api/mistakes` 接受可选
`Idempotency-Key`。提供时先 trim；空 key 或规范后超过 200 字符返回 400。
服务器 actor 固定为 `self`。同 actor、scope、key 和相同规范输入重放原创建终态、
真实 IDs 和 Location，并且仅在命中持久回执时返回 `Idempotency-Replayed:true`。
异输入返回 409 `idempotency_conflict`，不重复创建、发布或写事件。

canonical session 首发和重放成功均为 201，既有 `/api/ingestion` alias 成功仍为
200 并带弃用 header；二者共用创建 owner 和逻辑 scope。失败状态与安全 body、
Location 原样通过。回执保存 canonical 表示，同 URL 保持相同创建表示；不承诺跨
URL raw bytes 一致。无 key 仍可按原方式创建，不宣称可可靠重放。

回执冻结创建时的结果。资源后来失败、删除、撤回或 KC 归档，都不改变原 key 已经
绑定的身份。当前资源状态仍由原 GET 查询。重放查询在实时 subject/KC/cause/assets
验证之前；重放不再次物化或启动 agent。

## 专用持久模型和输入版本

`ingestion_creation_receipt` 紧跟 schema 的 `learning_session`，位于 `event` 之前。
真实主键为 `(actor_ref, operation_scope, idempotency_key)`，scope 只允许
`ingestion_session.create.v1` 与 `manual_mistake.create.v1`。其余列为
`input_version`、`input_digest`、`response_status`、`response_body`、
`response_location`、`created_at`。无资源 FK、TTL、裁剪、pending、租约或恢复器。
业务 writer 仅 INSERT，重放不更新行。仅存业务摘要与安全终态响应，不存请求题文或答案。

input_version=1 的摘要由当前 Zod parse 结果的固定字段 tuple 编码后计算 SHA-256：

- session：entrypoint、asset_ids、subject_id（omitted/null 归 null）、
  derivation_policy（omitted 为 null，explicit allow 保留 allow）。
- manual：prompt_md、reference_md、wrong_answer_md、knowledge_ids、cause
  （null 或 primary_category/user_notes tuple）、difficulty、question_kind、
  prompt_image_refs、wrong_answer_image_refs。默认图片数组沿现有 schema 归一为 []。

对象属性顺序不参与身份；字符串空白、图片页顺序、KC 数组顺序都保留。
回执输入版本未知、digest/schema 损坏或 body/Location 不匹配时返回固定安全
503 `creation_receipt_unavailable`，绝不当作 miss。连接、锁、写回执或 COMMIT
异常也不退化成无 key 创建；客户端只能沿原 key 和原输入重试。

## 实际事务和失败因果

私有 `creation-receipts.ts` 在一个实际 `db.transaction` 中持有
`pg_advisory_xact_lock(hashtextextended(JSON.stringify([actor,scope,key]),0))`，
然后查主键、验证原回执或执行完整创建 callback、插入 terminal receipt。
锁仅负责串行，三列真实 PK 与版本化指纹负责身份。hash 碰撞最多增加串行等待，
不会混淆查询身份。所有创建工作接收该回调的实际 Tx，没有独立持锁连接或 global-db
补写；事务 Promise 成功返回后 HTTP 才能观察创建结果。

session miss 的实时验证后，原 `Ingestion.initiateUpload` 接受 Db|Tx，既有事务
在 Tx 上变为 savepoint；原 document/session/uploaded job event 的创建体与守卫不改。
materialize 再使用同一外层 Tx 的 savepoint。它当前只读数据库、纯组装 package 并更新
document，不执行同文件的 Word/PDF/R2 生产函数，也不调用 provider 或 queue。

materialize 成功后写 201 回执。失败时先完成 savepoint 回滚，再调用原
`markSessionPackageFailed(tx, ...)`，且必须返回 `marked_failed`。随后返回固定
500 `ingestion_source_package_failed` error value，含真实 session/document IDs 和
Location；外层插入该失败回执并 COMMIT，HTTP 才返回 500。这里不 throw 业务失败，
因此不会把失败 session/回执一同回滚；也不会写 uploaded 成功回执遮盖失败。
mark、receipt 或 COMMIT 无法完成时整笔回滚或结果 unknown，不进行第二连接补偿。
同 key 重放失败只读原失败，不再次 materialize。

安装的 Drizzle postgres-js 实现中，`PostgresJsTransaction.transaction` 调用
`this.session.client.savepoint`；postgres-js 的 scope catch 先等待 `rollback to`
再抛出错误，outer transaction 使用另一 scope。该实现支持 savepoint 失败后在原
outer Tx 继续写 failed/receipt。这里是依赖源码核对，真实故障注入仍为 NOT_RUN。

manual miss 在同一 Tx 完整保留 question → 现有 kernel
`publishQuestionGroupFromRow` → frozen snapshot → attempt → learning_record →
optional user_cause 的顺序，最后插入回执。publisher actorRef 仍为 `mistakes:manual`，
attempt/cause actor 仍为 `user/self`；原 ID、时间、paid/unknown、订阅与 Memory
语义不改。GET reader 保持原样，不建立第二 publisher 或事件订阅。

## 备份、恢复和回退

长期回执进入 `FK_ORDER`，不进入 EXCLUDED 或 WIPE_ONLY，备份版本升为 4.33。
restore 保持既有 exact-version 检查，在任何 DB/memory wipe 之前额外要求
`data.ingestion_creation_receipt` 是数组；缺表或非数组拒绝恢复，不能把丢失的身份
当作空表恢复成功。迁移只新增独立表，没有执行 DDL 或恢复。回退应用代码时保留表
及已绑定回执，不能 drop/清空 key 来回退；旧应用不使用 key 的重复创建风险须由发布方处理。

## 职责边界与验收缺口

新增三个私有 server 文件都由现役 POST 消费；HTTP 只负责 parse、key 传递和表示适配。
manual 的两条遗留 server imports 迁为现有 kernel 真身，session 原有 server/session
依赖随完整 consumer 从 api/sessions 迁到 server/create-session，没有新增依赖种类。
schema 大文件仅追加独立表，保留 learner_axis_state 注释区、custom_provider 尾部和 0132。
source-package 仅三个函数及 Db/Tx import 类型拓宽，包排序、PDF fallback、Word/R2 算法不变。

UI、标题 reader、预算/history/operations/ask durable key、agent unknown、供应/准入策略和
DOCX `/api/docx` 均不在本片保证范围。创建幂等不授权额外付费启动。

本线不写、改、运行 tests/fixtures/断言脚本；不运行 DB、Docker、migrate、restore、
HTTP/browser、provider/paid、replay、daemon、部署或旧 unknown。真实并发相同/不同输入、
scope 隔离、资源删除后重放、savepoint SQL 故障、mark/receipt/commit/连接故障、备份恢复
均 NOT_RUN。静态通过不能替代这些验收。独立 R1/预算内 R2、exact-head CI 与合入归父线程。

## 本树静态交付证据

所有 install、生成、格式化和静态门均串行经
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh`，
`NODE_OPTIONS=--max-old-space-size=3072`；本线最多持有一个 heavy slot。
在最终基线 `6d99227eac5e68fe6f27bb90d4175d60b0cb5070` 接合后，重新运行受影响
的静态门，以下 `*-final.log` 均为该最终源码的结果。初轮日志保留。
日志目录为仓库外
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1522-creation-receipts-20261023/`。

| 命令 | exit | 日志 |
| --- | --- | --- |
| pnpm install --frozen-lockfile（唯一一次） | 0 | install.log |
| pnpm exec drizzle-kit generate --name yuk1522_ingestion_creation_receipt | 0 | generate-migration.log |
| pnpm gen:api-client | 0 | generate-client.log |
| pnpm gen:postman | 0 | generate-postman.log |
| pnpm typecheck | 0 | typecheck-final.log |
| pnpm lint | 0，164 warnings | lint-final.log |
| pnpm build | 0 | build-final.log |
| pnpm audit:api-contracts | 0，165/165 declared | api-contracts-final.log |
| pnpm audit:api-client | 0，真实重生后与已暂存生成物无差 | api-client-final.log |
| pnpm audit:api-client-usage | 0 | api-client-usage-final.log |
| pnpm audit:schema | 0，unallowed stub=0 | schema-final.log |
| pnpm audit:capability-boundaries --base 6d99227eac5e68fe6f27bb90d4175d60b0cb5070 | 0 | boundaries-final.log |
| pnpm audit:architecture-deepening --base 6d99227eac5e68fe6f27bb90d4175d60b0cb5070 | 0 | architecture-final.log |

边界初测仅要求登记真实增量，原失败日志保留于 `boundaries-initial.json.log` 和
`boundaries-measured.json.log`。最终追加 11 条 edgeRecords（10 条 kernel 消费边和
1 条随 consumer 搬迁的 session 既有依赖）及 schema 5002→5028 行的 sourceSizeRecord。
仅收紧 ingestion→questions 11→9、capability→server 总数 327→325；
server→capability-deep=0、cross-capability-value=39、非平凡 SCC=1 均保持。
超 1500 行文件仍为 9 个，新 pass-through=0；没有放宽 audit 或旧 baseline。
快照相对 0132 只增加本表及根 id/prevId；schema 只有独立表 hunk。

无新增已验证 follow-up；本片预先列明的运行与恢复缺口、Linear 状态和独立审查统一交父线程，
writer 不另建票、不改父树或父 Linear。
