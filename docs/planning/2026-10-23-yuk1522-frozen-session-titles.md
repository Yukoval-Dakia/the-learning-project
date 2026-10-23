# 录入历史的冻结来源标题（YUK-1522）

本片服务原 R8「帮助靠谱」读面，仅交付独立后端标题读取及 draft PR。
不代表 YUK-1522 全票、独立审查、exact-head CI 或运行验收完成。

## 基线与范围

- 独立 worktree：`/Users/yuqi/.t3/worktrees/the-learning-project/t3-014002e0`。
- fresh fetch 基线：`411ad9f13cde1a363b3810e6a727eaeedbfdf894`。
- 分支：`feat/yuk-1522-frozen-session-titles-20261023`；保留 T3 初始分支。
- 复用准备：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-ingestion-budget-history-20261020/title-read-prep-a59fe2cf.md`。
- 不改 UI、创建 POST、幂等事务、DDL、manifest、public 出口、历史写者、预算协议或 paid 生命周期。
  未触碰父树、2037 与 1969 的 worktree，也未吸入这些 PR。

## 完整读取 owner 与真实消费者

`server/session-titles.ts:readSessionTitles(db, sessionIds)` 是两个 GET 共用的完整标题 owner。
调用者只提供已选页的 session IDs，不掌握身份、事件 floor、读取次序、来源选择或排序。
列表保留原 SQL 证据筛选、排序、limit+1、cursor 和计数，选页后一次调用，最多 100 个 session。
历史 GET 同样调用它，不改变 items、asks、current、prior_runs 或 evidence 的原读取义务。

真实消费链：

- `GET /api/ingestion-sessions` → generated `listIngestionSessions` →
  `record-api.ts:listSessions` → `recording-read.ts:useRecordingList` → `HistoryList.tsx` 的 `row.title`。
- `GET /api/ingestion-sessions/:id/history` → generated `getIngestionSessionHistory` →
  `record-api.ts:getHistory` → `recording-read.ts:useRecording` → 现有 `recording-title.ts`。

本片不复制 UI 的 20 字截断或 markdown 清理规则，所选来源文本原样返回。
不补写 `source_document.title`，不编造文件名、题号、无文字占位，不读取 mutable question/structured 文本。

## 来源与未知边界

1. `source_document.title != null` 时仍优先返回它，包括空串；来源 `source_document`。
2. 否则读取当前 execution owner 的冻结 agent items：有效且非空的 `run_ref` 与显式非负
   `event_floor` 缺一不可。snapshot 必须通过现有完整 schema、为 v2，且经现有
   `snapshotMatchesRun` 匹配当前 owner。只读 `id > event_floor` 的合法 item/session 与
   item_state/run 事件。共用 ledger 的纯 item 折叠及 history 的 `mergeItems`：保留第一次
   出现顺序，同 item_id 后续字段覆盖；再按 `parseInt(question_no, 10) || 0` 稳定升序，
   跳过空白，首个可读 preview 原样返回，来源 `agent_item_preview`。
3. 无可读 agent preview 时，独立读取 immutable `question_block.extracted_prompt_md`。
   actor-scoped `draft:ingestion_agent:<sessionId>` 先按 `created_at/id`，然后 session-bound
   captures 按 `ordinal/id`，跳过空白，来源 `extracted_prompt_md`。
4. 无证据时 `title` 与 `title_source` 都是 null。v1、身份/floor 缺失、坏快照、prior run、
   opaque `unparsed_previous` 不提供当前标题。合法 live items 可独立提供冻结证据；
   独立 immutable block 也可回退。不以一个标题的存在声称完整历史已恢复。

## 一致性与依赖

每次 owner 调用只开启一个 `REPEATABLE READ / READ ONLY` 事务，在同一视图里读取 document、
owner/snapshot、所需 item events 和 blocks，避免并发换 run 拼接。SQL 次数有固定上界（最多五次），
不逐行调用 `readAgentRunHistory`，不读取 asks/errors/paid 来重建标题。
列表选页与计数、历史其它切片保留原事务边界；本片不声称整个 HTTP 响应是一个统一数据库快照。

`agent/history.ts` 只新增批量只读 item projection，复用现有 schema、身份判定和 merge；
`agent/ledger.ts` 只提取并复用原 item 纯折叠。`persistAgentRunHistory`、预算/floor 写入、
claim、dispatch、追问、历史保留均不变。无新增跨 capability 或 capability→server 依赖，
无模块导入时读取或启动资源。

## 验证与交接

所有重命令串行通过 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh`，
`NODE_OPTIONS=--max-old-space-size=3072`，不覆盖 limiter。日志目录为
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/`，下表文件名均以前缀
`yuk1522-titles-` 开始。

| 命令 | exit | 日志后缀 / 结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | `install.log`；仅一次安装 |
| owned TS/JSON `pnpm exec biome check --write …` | 0 | `format.log` |
| `pnpm gen:api-client` | 0 | `gen-api-client.log`；仅 ingestion title_source 六处生成差量（共享 read schema 的真实产物） |
| `pnpm gen:postman` | 0 | `gen-postman.log`；仅两个 GET |
| `pnpm typecheck` 首次 / 修正后 | 2 / 0 | `typecheck.log` / `typecheck-2.log`；修正 Drizzle sql.join 的 readonly 数组类型 |
| `pnpm lint` | 0 | `lint.log`；164 warnings |
| `pnpm build` | 0 | `build.log`；web、Start、server、worker、migrate 构建均完成 |
| `pnpm audit:api-contracts` | 0 | `api-contracts.log`；165/165 declared，0 legacy，155 paths |
| `pnpm audit:api-client` | 0 | `api-client.log`；生成物已暂存后重生成无 unstaged 差量 |
| `pnpm audit:api-client-usage` | 0 | `api-client-usage.log` |
| `pnpm audit:capability-boundaries --base 411ad9f13cde1a363b3810e6a727eaeedbfdf894` 首次 / 登记后 | 1 / 0 | `capability-boundaries.log` / `capability-boundaries-2.log` |
| `pnpm audit:architecture-deepening --base 411ad9f13cde1a363b3810e6a727eaeedbfdf894` | 0 | `architecture-deepening.log`；0 new pass-through，依赖总数 327/0/39 |
| baseline JSON `pnpm exec biome check …` | 0 | `baseline-format.log` |
| `git diff --check` / `git diff --cached --check` | 0 / 0 | Git 原生静态差量检查 |

boundary 首次仅报 `agent/history.ts → kernel/http.ts` 的 `ApiError` 新边未登记。
baseline 仅追加该机器真实报项的精确 file/module/symbol/issue/owns；不改变门限、债务计数、
分类或豁免。新 owner 105 行，history 733 行，ledger 342 行，均未跨 source-size 门限。

完整交付文件：`src/capabilities/ingestion/server/session-titles.ts`、
`src/capabilities/ingestion/server/agent/history.ts`、`src/capabilities/ingestion/server/agent/ledger.ts`、
`src/capabilities/ingestion/api/sessions.ts`、`src/capabilities/ingestion/api/session-history.ts`、
`src/capabilities/ingestion/api/contracts.ts`、`src/ui/lib/api-schema.generated.ts`、
`postman/api-endpoints.json`、`postman/learning-api.postman_collection.json`、
`scripts/capability-boundary-baseline.json`、本设计文档，共 11 个 owned 文件。

本线禁止且未执行：测试/fixture/断言脚本、DB、Docker/daemon、browser、产品 HTTP、provider、
模型/paid、runtime、部署、配置或运维操作。首轮独立审查与 exact-head CI 交父线程。
Linear 原票和全局状态由父线程维护；本片没有发现需另开票的独立 actionable follow-up，
未创建重复票。未知标题与运行验证缺口已是原票范围，不另算完成。未 watch/poll/merge/resolve PR。

## 父侧正常整合与静态验证

父已读取完整 11 文件差量和原始日志。实际 main 前进至
`6ab35c4b372797b5426f6f3f670dd5932ba10fca`（含 DOCX 完整操作与 Practice Start 交付），
正常 merge 为 `c1107623609459f94ef960407f54539f8cc6dc02`。
唯一冲突为 baseline 追加位置：完整保留 main 历史及 DOCX 登记后，追加本片原 ApiError 边；
不放宽 audit。Git 原生对照确认本片产品和生成物与原 `6a7abffc8` 全同。

组合后父以 external heavy limiter 串行运行 typecheck、lint、build、
capability-boundaries 和 architecture-deepening，五项均 exit 0；lint 164 warnings。
原始日志位于
`/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/stage1-yuk1522-frozen-titles-20261023/parent-c110-*.log`。
两架构门固定比较上述实际 main，依赖总数 327/0/39，新增 kernel 边 1，新增 pass-through 0。

原 `6a7abffc8` 的 Circle architecture job 11708 实际 audit 失败，原日志保留为
`pr2045-6a7-circle-architecture.log`（同目录）：其原始 head 未包含新 main 的 DOCX 迁移和
追加记录，报 append-only 及对应边登记冲突；没有重跑或称原结果通过。
父正常整合后只认可新组合的真实门与后续 exact-head CI，不外推旧绿。

本片唯一独立 R1 已固定 `c11076236` 启动，尚无结论；此后仅文档记录不改变受审产品。
测试、DB、产品 HTTP、provider、browser、paid、runtime 和部署仍为 NOT_RUN。
2037、1969 的待批测试与迁移顺序均保持原样。
