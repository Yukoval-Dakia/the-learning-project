# 题库逐条件语义核验：实现与验收边界（YUK-1448）

日期：2026-10-22。阶段：按真实时间安排。权威需求为 YUK-1448 的 2026-10-19 owner 确认及已 APPROVE 的 LIGHT → FULL 规格；本次按父指定范围交付唯一 `search_bank` 的真实读调用链，不代表完整 L1 或 LIGHT 已完成。

## 工作树与依赖

唯一实施 writer：本 T3 隔离工作树 `/Users/yuqi/.t3/worktrees/the-learning-project/t3-24ce03ea`，分支 `feat/yuk-1448-search-semantic-verification-20261022`。已 fetch，旧 ee4b 本地 HEAD 落后 origin/main 225 commits，正常从真实 `606188535711229e135908b74016624a5f1a05ea` 新建分支；父 `/stage1-lead` 未写。PLAN/.remember 仅本树 ignored 进度，不提交。

共享边界只释放 `schema.ts` 的 `tool_operation` 前独立新表，以及 export/constants 的同表排除与恢复清理登记；不修改既有表、learner_axis_state 注释、EOF custom_provider 或他人分支。

协调给本片保留 `drizzle/0133_yuk1448_bank_search_snapshot.sql`，真实 additive SQL 与产品声明同交。**最终 `0133_snapshot.json` 和 `_journal.json` 由父在 writer 释放、0132 正常合入实际 main 后单 writer 普通 merge，再从真实 0132 生成。** 当前基线实际末项仍为 0131/1792580511426；#1926 的 0132/1792593153036 尚未合入，旧 CI 不覆盖当前组合。不得伪造 132/prevId、取 NOT_APPLIED 候选、重编号或手补 journal 放过审计。顺序裁定见 [协调原 PR 评论](https://github.com/Yukoval-Dakia/the-learning-project/pull/1926#issuecomment-6324180292)。本候选因此尚不具备完整迁移 metadata，不能部署。

## 真实调用与结果

现役 `practice/manifest.ts` 已注册、Copilot allowlist 已授予的 `search_bank` 直接分流显式 v2 到语义链；没有新工具、agent、演示路由或后台任务。新 TaskSpec 在 practice owned map 注册，经现有 task-public/catalog 汇合；运行通过 capability-local `makeRunTaskFn`，provider/model/reasoning 来自已解析任务配置。Copilot prompt 指示结构化条件、原话、未知与截断解释。

新检索输入保留 query、required/preferred、scope、use、need.count、page_size。结构化条件不被重写；只有 query 时配置任务解释并返回原话 UTF-16 spans，确定性核对每个 span 与完整 id；歧义/解析失败保持 needs_clarification，不能报需求满足。数量只来自 need；无 need 为 not_assessed。锚题输入为 question_ref、preserve、change；同角色同版读取，比较条件逐条加入并保持原语义。

SQL 硬范围仍先于每通道候选上限。实际发题门仍由 `readBankServableParts`/issuance 实现；各通道按稳定 SQL 顺序每批 200 补取，最多扫描 2000 行，收足 200 合格候选加一个截断见证、通道穷尽或物理扫描预算后停止。RRF 只融合合格池，原距离 0.55、top-1 margin 及校准文件未改；旧 counted 标记不决定 v2 semantic matched。

角色复用 `bankReadRoleForActor`，不升级 Copilot、不新增私有读 allowlist。restricted v2 的 FTS 只用公有 prompt/choices，旧向量混入 reference_md、无 visibility 证明，故查询前禁用该通道及无用 query embed，包括 similar_to seed；返回 vector_reason/unavailable_channels。owner/private 保留 FTS+vector/RRF。**restricted 本片交付是 FTS-only，不能称完整混合召回。** v1 旧行为保留并明确 legacy_candidate_only，不声称其私有召回问题已修。按 visibility 分层的 L2 索引仍未交。

召回和有权限同版读取在短只读 repeatable-read 事务冻结，事务结束后执行无工具解释/核验任务，再短事务重验状态并保存结果。每候选只取真实 revision 内容，不用 mutable reference_md 当核验原文。每项证据校验 locator、原文 quote 和 offset；同题共同成立另检查 joint，选中 parts 必须合法且满足用途。共享材料按本题绑定定位；未实际读到的媒体、权限缺失、文本截断或摘要不符保持 unknown。caption/alt/OCR 不能冒充看图。

核验策略版本 `bank-semantic-v1-20261022`：最多 20 候选逐题核验，总墙钟 180 秒并受父调用更短 deadline/取消约束；每字段读取上限 200000、每候选送模型原文预算 90000 字符，超限明确缺证。达到明确 need 可停止；失败不重发同次 unknown。全部 required 与 joint 支持且用途可用才计 matched；preferred 与原 RRF 顺序只在同组内排序，保留前后 rank。未核题、反证、用途不可用分别返回。global enforced 仅确定性硬范围，条件通过只放 checks；不从空池、翻完本池或页大小证明全库 absence。

任务回执使用真实 task-run、provider/model、输入/输出 digest、compiled prompt、usage、cost 与 transport 证据引用；执行真相与产品校验结果分别保留。费用无证时 null/unknown，不补 0。不修改 paid/fallback/retry 协议，不持事务等待模型。

## 快照、恢复与兼容

`bank_search_snapshot` 是十五分钟 actor/role-bound 内部分页缓存，保存完整结果/版本状态与请求、结果 digest。cursor 用现有 server-only bank signing key 做域隔离 HMAC，绑定 actor/role/search/request/result/offset/expiry；key 不可用在任何语义模型前返回明确错误。续页只读缓存并重验整池当前版本、撤回/准入/权限和资产身份，不重新 embed/核验，不自动换 latest 或缩池保留旧计数。缺 snapshot、过期或恢复清理后明确 stale。

每次新 v2 检索有界清理最多 100 过期条目。learner archive backup 将该表列为 transient excluded，restore 通过已有事务的 RESTORE_WIPE_ONLY_TABLES 清理即使尚未到期的旧 cursor；不改备份版本或 archive 恢复算法，不声称全 PostgreSQL 恢复已经验证。已登记 gap 不应依赖本缓存，本片尚未接 gap 登记。

本片返回 evidence_ref=null、redeemable_for_gap_or_issuance=false，没有 v1 gap_request/HMAC 供题凭证。need 的已登记 demand 身份/digest、supersedes 授权在 L3 真相源未接前明确 unsupported，不能静默降级。旧 v1 query/limit/cursor 保留原候选契约，新增 v2 字段必须显式版本，不能被 Zod strip 后伪装 v1 成功。

## 尚未交付的规格义务

- 版本化 write_quiz → tool_quiz → issuance 事务交接（完整 L1 的剩余部分）；旧 question_ids 不能获得已核同版发行凭证。
- L2 revision/material/long-text/visibility manifest/document、索引代与回填；当前报告 legacy unversioned projection 与覆盖缺项。
- L3 registered-demand 真相源/record/observe/跨搜索库存归约、取消与派发 fence、缺口闭环；本片不写缺口也不派供题。
- F1/F2 方法/关系/真实多媒体索引与核验；真实学习效果、检索精度与费用验收。
- LIGHT13/+9 owner 迁移仍 PARKED；本片只复用已有准入门。matcher/refill/阈值文件未改。

## 验收 TEXT（未执行）

以下只是真实请求与预期观察，不是测试代码或实际输出。后续执行须父授予对应 DB/provider/runtime 资源，测试代码仍须 owner 单独批准。

1. Copilot 实际工具请求 v2，原话“包含多次碰撞，以及弹簧与斜面的物理动量大题”，明确四项 required 与同题关系，无 need：逐项证据原文、revision/digest、joint、未知/媒体缺失与 not_assessed 可读；不把多个分别命中的题拼成一题。冻结 owner 盲题 NOT_RUN，不用于调阈值。
2. 同一明确 need.count，page_size=1/20，使用各自新搜及各自 cursor：同快照 matched/remaining 不变，续页 task-run/attempt/费用无新增。query-only 否定/关系歧义返回 needs_clarification；结构化条件原样回显。
3. 首 200 行不可出、后续有可出题：每通道继续补取；到 2000 行时 scan_budget/retrieval_truncated，不能报全库无题。KC/within/exclude/difficulty 与 subject 硬范围保留，不放宽。
4. 缺图、私有材料拒读、长文超限、模型超时/无效 JSON/自造 quote：对应 required unknown、verification partial/failed 与具体原因；未知费用 null。条件反证不会被 preferred 抵消。
5. 同题多部分、共享材料和锚题：selected parts 与 citation 的授权材料绑定一致；practice 仅真实可出部分计数。revision A 搜后发布 B/撤回/缺资产，旧 cursor stale，不取 B 替 A。
6. actor/role 不同、cursor 请求/结果/offset 篡改、到期/缓存缺失、learner archive restore：拒绝或 stale，零重新模型。v2 evidence 无法兑付旧 file_bank_gap，旧 question_ids 不冒充同版 issuance。
7. restricted 输出 vector_reason，旧向量及 embed 均未执行；owner/private 如确有配置可走两通道。provider/model/任务 revision、attempt、用量/成本按真实账逐项对账，不伪造 actual output。

39 条/K7、owner 盲题、DB/TEST/Docker/provider/付费/browser/后台/部署/真实产品验收：全部 NOT_RUN。无断言/测试脚本；tests/cases/fixtures/测试配置均未修改。最终静态检查和 commit/PR head 在交付回执记录；迁移 metadata 的具体依赖如上，不以静态源码代替运行验收。

## 本候选静态交付回执

本机全部重活经指定 heavy.sh，lane 串行、全机两槽，Node 堆上限 3072。frozen install exit 0，无 lockfile 改动。

- `pnpm lint`：exit 0，181 warnings；日志 `/tmp/yuk1448-lint-final.log`。
- `pnpm build`：exit 0，web/Start/server/worker/migrate 全部打包完成；日志 `/tmp/yuk1448-build-final.log`。这不是启动或迁移验收。
- `pnpm typecheck`：exit 2，29 条诊断全部位于未修改的 `bank-tools.db.test.ts`。真实输出现在是 v1/v2/error discriminated union，旧 `searchHits` helper 和另一处 direct execute 尚未运行时收窄 v1；最小两处迁移 TEXT 已交父等待 owner，不用 cast/any/假 v2 legacy coverage 或第二 parser 掩盖。日志 `/tmp/yuk1448-typecheck-final.log`。该命令在第一项目失败，后续 Start 检查未执行；另外单独执行现有 `tsrs --noEmit -p server/start/tsconfig.json` exit 0，日志 `/tmp/yuk1448-typecheck-start.log`。
- `audit:task-census`：exit 0，60 注册、58 静态调用、2 兼容、75 production call sites；生产组合总量仅按批准 58→60，不改校验器。日志 `/tmp/yuk1448-task-census-final.log`。
- `audit:tool-params`：exit 0，practice 20 tools、所有可枚举表面 0 violation，v2 顶层仍 object。日志 `/tmp/yuk1448-tool-params-final.log`。
- `audit:capability-boundaries`：exit 0；capability→server 384、cross-capability value 36，均未增加；kernel 的 1 新路径是旧 import 退出后的完整 scope 职责迁移。bank-search 1312→1164，schema 4974→5002；baseline 只加两项必要登记、19 行，无其他记录重排。日志 `/tmp/yuk1448-boundaries-final.log`。
- `audit:model-source`：exit 0，114 derived model ids；日志 `/tmp/yuk1448-model-source.log`。
- `audit:provider-lanes`：exit 0，violations=[]；日志 `/tmp/yuk1448-provider-lanes-final.log`。初次把名为 fetch 的数据库批读 callback 误识别为 wire；已改为表达真实职责的 queryBatch，实际 provider seam 不变，没有改 inventory/审计器或加豁免。
- `audit:schema`：exit 0，1061 fields、unallowed stubs=0；这是源码写入 census，不能替代未完成的 0133 metadata 或真实迁移。日志 `/tmp/yuk1448-schema.log`。
- `git diff --check`：exit 0。tests/cases/fixtures/测试配置字节无变动；没有新增断言或测试脚本。

初次 lint/边界/任务审计的失败已按真实源码与生产总量修正；不把先前失败说成通过。独立 R1/必要 R2、exact-head CI、Linear 与 merge 由父接管，writer 不 watch/poll/merge。没有新独立 follow-up 票：本片未交义务均仍在原 YUK-1448 范围，由父归档。

本片共 19 个 task-owned 文件：tools 下的 search-bank、bank-search、read-bank、bank-search-scope、bank-search-channel、bank-requirements、bank-verification、bank-semantic-search、bank-search-snapshot；practice/tasks 下的新 bank-search-semantic 与 index；capabilities/task-catalog、copilot/tasks/agent；db/schema；drizzle/0133 SQL；export/constants；capability-boundary-baseline；ADR-0072；本文。没有改 manifest/allowlist、matcher/refill/threshold、issuance 或旧 gap writer。
