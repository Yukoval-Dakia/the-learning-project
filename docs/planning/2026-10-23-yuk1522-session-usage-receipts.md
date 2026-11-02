# 录入会话完整持久隐私使用回执（YUK-1522）

交付阶段：第一天能用。Refs YUK-1522，沿用原票已批准的完整历史/隐私回执后续 G10；
原评论 `298b5270-393f-45c4-a6bf-a22d689310c0` 将此项排在 G1–G7 后，本片只实现独立后端读取。

## 固定对象与职责

- 隔离树：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-9cfc1840`。
- 初始分支 `t3/9cfc1840`，初始 ref `ee4b92bea329dde7d88609469e217dd2bb473c1d` 保留。
- `git fetch origin` 后落后 307 commits；从 fresh `origin/main`
  `8b3054f4abf1b3712dd6888f0a1706e25abb33d3` 建立
  `feat/yuk-1522-session-usage-receipts-20261023`，不整合其它开放 PR。
- 相对父核 `0e17eca060d484118d090f9609872d1832a2d7ba`，owned 读取源码与 contracts 未变；
  fresh main 台账增加 Practice paper reader 记录，完整保留其前缀。
- 新 `ingestion/server/session-detail.ts` 拥有 ingestion session 查询、原 404、完整归属回执读取、
  聚合及 live policy。`api/session-detail.ts` 仅作现有 HTTP consumer 和 `errorResponse` 映射。
  新模块不是无职责 wrapper，没有新增 public export、manifest 入口或共享事件引擎。

## 旧行为与真实 consumer

原 GET 在 session 查询之后，经 `getEvents(db, {subject_id: document, limit: 1})` 读最新一张。
既漏掉同会话旧段，又没有限定 `event.session_id` 与可信 writer；session、event、policy 也不在同一快照。
`server/agent/run.ts` 的 `writeRunReceipt` 每段调用 `privacy-guard.ts` 的
`writeIngestionUsageReceipt`，该 writer 创建独立不可变 event。

真实读取链保持为：现有 manifest `getIngestionSession` → `GET /api/ingestion-sessions/[id]`
→ `record/record-api.ts#getSession` → `recording-read.ts#useRecording`
→ `RecordingSheet` 的 `detail.usage_receipt` → 原 counts/channels/current policy 显示。
没有新增入口、UI 或演示页面。Postman 原未描述这条已有 GET，本片仅补其描述并由原生成器生成 collection。

## 读取与聚合契约

1. 使用一个 `db.transaction`，设置 `isolationLevel: 'repeatable read'` 和
   `accessMode: 'read only'`。session、全部 receipts、document live policy 均用该 `tx`。
   缺 session 或非 ingestion 类型维持原 `not_found / ingestion session not found / 404`。
   session wire 字段与日期格式不变；全局 token 授权与 `errorResponse` 不变。
2. 直接只读 event 表，仅取 id、payload、created_at；同时限定本 session id、当前绑定的 source document id、
   `subject_kind=source_document`、`action=experimental:ingestion_usage_receipt`、
   `actor_kind=system`、`actor_ref=ingestion_privacy_guard`、`outcome=success`。
   这些 envelope 值来自原可信 writer。其它 session 共用 document 也不会计入。
3. 无 receipt limit、无默认事件上限、无时间窗或 run/segment 推测。单表无 join、event.id 是主键，
   每个真实持久 event 恰一次；按 created_at/id 升序读取至完整结果。
4. `redaction_counts` 按分类累加各次已记录使用的 mutated-span 数；同原文在不同段/不同 run
   再次使用仍计入。segment 号跨 run 可重复，不作去重键。不是唯一原文位置、模型调用数或费用。
   `redacted_fields` 分类并集并排序；`recorded_at` 为已读事件实际最大 created_at。
5. 所有 engine 相同且已记录时保留原值；混合或任一缺失返回 null。
   channels 各维度取已记录使用并集：曾 raw/redacted 则保留，否则所有都记录 none 才为 none；
   任一 receipt 缺 channels，整个 channels=null，不把缺失猜成 none。
6. 无 receipt 返回 `usage_receipt=null`。任一合法 `redaction_accounting=unavailable`
   （writer 的 fields/counts 为 null）也使整体 null，后来的正常 receipt 不能抹掉旧缺账。
   仍验证所有已归属 payload；非法 payload、负数/非整数/不安全 counts 或求和溢出明确失败，
   通过原 errorResponse 返回通用 500；错误中不携带 payload、原值或 Zod diagnostics。
7. `derivation_policy` 使用同快照内 document 的 live policy；保留历史 event 的 policy_version、
   derivation_policy 和授权撤回事实，不写回或以历史值覆盖 live policy。
8. wire 字段与类型不变，contracts 只更新现有 receipt 语义注释。经典 OCR、DOCX 与单段
   合法回执仍按原 engine/channels/counts/policy/time 读取；分类数组表达同一集合。

## 边界与缺证

只汇总已持久事实，不证明所有实际模型调用都已记账；没有 receipt 的调用不能靠 run、时间或费用反推。
完整查询不截断，结果量随该 session 持久回执数增长；本片没有数据库或性能实测。
未改 privacy guard、run/history/ledger、receipt identity/写入、source 内容、policy、预算、paid、provider、
manifest/schema/migration、UI/useEffect 或测试。台账只追加真实迁移到新 owner 的 kernel 消费边，
不改 gate、计数范围、规则或例外。

本片实施子任务唯一 writer，未再委派或自行启动审查；父按新产品原预算安排首次独立R1，
仅在P0/P1修复后可安排一次验证R2，不开第三审。按授权禁止新增/修改/运行 tests、fixtures、断言、probe、driver；
DB/SQL、HTTP 业务、browser/Chromium、provider/paid、Docker、部署和运行验收均 NOT_RUN。
源码与 bundle 检查成功不代表生产行为通过；父负责真实diff、独立审查裁决与最终组合。

## 本地检查证据

所有 install/generator/typecheck/lint/build/audit 命令均逐个通过
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh`，本线同时最多一个重活，
不覆盖其 Node old-space 3072。日志和退出码位于本树 ignored
`.remember/yuk1522-session-usage-receipts/`；不提交 PLAN/.remember。
执行命令与实际结果（log 同名，退出码另存 `.exit`）：

- `pnpm install --frozen-lockfile` → exit 0，`install.log`；依赖缺失时唯一一次 install。
- `pnpm gen:postman` → exit 0，`gen-postman.log`；38 folders / 103 paths / 111 requests。
- `pnpm exec biome check --write`（仅本片五个手改 TS/JSON 文件）→ exit 0，`format.log`。
- `pnpm typecheck` → exit 0，`typecheck.log`。
- `pnpm lint` → exit 0，`lint.log`；2772 files / 165 warnings，无 errors。
- `pnpm audit:api-contracts` → exit 0，`audit-api-contracts.log`；165/165 declared / 0 legacy / 155 paths。
- `pnpm audit:api-client` → exit 0，`audit-api-client.log`；原生成器执行后 client 类型无 diff。
- `pnpm audit:api-client-usage` → exit 0，`audit-api-client-usage.log`。
- `pnpm audit:capability-boundaries` → exit 0，`audit-capability-boundaries.log`；
  debt totals 318/0/39、新边恰为两条登记的 kernel 消费边，深层跨域 import 为 0。
- `pnpm audit:architecture-deepening` → exit 0，`audit-architecture-deepening.log`；
  新 pass-through 0，dependency totals 318/0/39。
- `pnpm build` → exit 0，`build.log`；web、Start、server、worker、migrate bundles 完成，
  日志保留 bundle size / ineffective dynamic import 等 warnings。未启动任何产物或迁移。

所有授权的本地检查均成功，无任务造成的未修复失败。构建产物与 API 生成临时文件不提交。
Linear capture 已按 `YUK-1522` 和 `usage receipt` 去重；本片为原票既定范围，缺证与后续真实验收
仍归原票，没有新增已验证的独立 actionable follow-up，不另开重复票。实施子任务以draft PR交父，
未观察CI或自行review/resolve/merge/deploy；父继续既定审查、本地门与exact-head CI合入流程。

## 父接线核对与实际 main 组合

父读取原固定七文件差量、原可信 receipt writer 及现役 record-api/RecordingSheet consumer，
核对 session/document/writer 归属、所有记录读取、event 主键单次计数和 unavailable 持续缺账分支；
没有修改产品语义或新开审查。原日志和 `.exit` 已实际读取，所有命令均0。

实际 main 前进至 `8f76ea89c5c81ea18c7de14a02a2828ee3b47006`（#2057）；
相对原 base 仅卷复盘 `PfRetro.tsx` 的4行 UI 改动，与本片无交集。父正常 merge，
上游完整保留，本片六个非文档文件与作者固定 `1142a8ad` 全同。
新组合经同一 heavy limiter 串行完成 typecheck、lint、build、capability-boundaries、
architecture-deepening，五门均0；lint165 warnings，边界318/0/39，新pass-through0。
日志 `.remember/yuk1522-session-usage-receipts/parent-main8f76/`。
API三门沿原固定源码结果，没有为未变合同重复执行生成器/检查或安装。

新 exact-head CI 与本地门分开，原1142 CI不外推到新组合。原Circle镜像architecture/policy
红状态保留，未重跑、未据状态归因；不写成全绿。此前把Sidekick“不复审”误读为开发线
不得启动新diff首次R1并停在draft，现依Owner现行规则纠正：本片按原预算首次R1、
必要P0/P1修复验证及最终exact-head Gate继续交付；没有更晚的2059精确禁审裁定。
测试代码/本机测试、DB/SQL/业务HTTP/browser/provider/paid/runtime/部署均NOT_RUN；
原2037/1969测试TEXT与0133/0134安排未动，YUK1522继续In Progress。

## 恢复正常首次独立审查与最终组合

Owner进一步明确Sidekick限制不禁止开发线对新产品diff做原本首次独立R1；前轮停止
措辞是父的误读，不存在更晚的2059精确禁审或仅源码准备裁定。父已启动本片首次R1：
`stage1-pr2059-usage-receipts-sol-xhigh-r1-e9c80915-20261023-v1`，
Codex gpt-6.1-sol xhigh/default，只读固定base8f76与heade9c80915f的真实七文件。
本节记录时审查进行中，不预报结论；如有已证实P0/P1，仅修复后最多一次验证R2。

父正常merge实际main `bacf1a0a1002d25bd168dda8a1ff32747b0ff831` 为 `cef4d0535`。
八个上游commit完整保留，唯一冲突是baseline的edgeRecords追加位置：保实际main全部
changes/edges/sizes/debts前缀，再追加本片原两条reader记录。两个产品TS、contracts与
Postman生成物相对e9c均无差量；package/lock无变化，不安装或重跑生成器。
新组合经同一heavy limiter串行typecheck、lint、build、capability-boundaries、
architecture-deepening五门exit0，日志`parent-mainbacf-r1/`。
最终新head的exact GitHub Gate与旧e9c结果分开，需独立R1无未决P0/P1及其余门满足后
才按match-head合入；不设置17分钟等待，不为advisory重跑或增加审查。测试、DB、
业务HTTP/browser、provider/paid/runtime/部署权限保持原样。
