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

核验策略版本 `bank-semantic-v2-20261022` 与完整公开槽位投影绑定（替代初版 `bank-semantic-v1-20261022`，wire contract_version 仍为 2）；旧策略快照沿现有 policy 比较返回 stale。最多 20 候选逐题核验，总墙钟 180 秒并受父调用更短 deadline/取消约束；每字段读取上限 200000、每候选原文与完整槽位 JSON 共用 90000 字符预算，超限明确缺证。达到明确 need 可停止；失败不重发同次 unknown。全部 required 与 joint 支持且用途可用才计 matched；preferred 与原 RRF 顺序只在同组内排序，保留前后 rank。未核题、反证、用途不可用分别返回。global enforced 仅确定性硬范围，条件通过只放 checks；不从空池、翻完本池或页大小证明全库 absence。

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

## 初版候选静态交付回执（0fe7271b）

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

含本次 R1 修复，本片共 20 个 task-owned 文件：tools 下的 search-bank、bank-search、read-bank、bank-search-scope、bank-search-channel、bank-requirements、bank-verification、bank-slot-evidence、bank-semantic-search、bank-search-snapshot；practice/tasks 下的新 bank-search-semantic 与 index；capabilities/task-catalog、copilot/tasks/agent；db/schema；drizzle/0133 SQL；export/constants；capability-boundary-baseline；ADR-0072；本文。没有改 manifest/allowlist、matcher/refill/threshold、issuance 或旧 gap writer。


## R1 唯一 P1 修复：公开槽位证据完整性

起始 head `0fe7271b83db0ef4d03fe5ab3a2fc17d245cbc43`。唯一 writer 仍为本树，无另委派或自行审查。R1 指出 read_bank 已读到的 slot.detail 被 adapter 丢弃，原本只冻结 options.text；这会漏判，也可能在输入不全时仅引题干获得 complete/matched。属于本片输入完整性错误，不归入 L2 未交义务。

已普通 merge 真实 origin/main `7142cd969f3a7225983185232efd31f2bf9ff43a`（包含 #1968/#1970），merge commit `fdac7a0720446d91fd8f62109a8f0ae6815144c2`。无冲突；main 的三条 public contract 登记与本片 baseline 增量均保留，没有覆盖旧 48 条记录或改审计器。0133 SQL/schema 不变，最终 metadata/journal 仍只待真实 0132 合入后由父整合；未取 #1926 未合内容。

`bank-slot-evidence.ts` 只消费同角色 runReadBank 返回的公开 slots。复用现役 ResponseSlot 及其成员 schema 的 strict 视图校验原始字段，避免未知字段被 canonical parser strip 后假称完整；复用 validateResponseSpec 校验同版 part、重复身份、select 坐标/字缝和 table 子槽引用。没有第二套 response codec 或私有答案权限表，没有读取 mutable question/options。完整 canonical slots（含默认输入语义）及关系直接交给现役核验 Task；原文字段另有 literal passage，不把 describeSelectItem 或 JSON 序列化当原文引用。

| 现役公开槽位 | 原文 passage | 一起传给 Task 的身份、关系与输入语义 |
| --- | --- | --- |
| 全部 12 类 | placement.label（存在时） | slot_id、part_id、kind、placement.row/col |
| single_choice / multi_choice | options[].label / text | option_id 与原数组顺序；min/max_select |
| select | items[].label_md、axes 各 entry.label_md、text | item_id、axis 名及 entry.id、coordinates、gap_after_codepoint→本槽 text、at_most_per_coordinate、pick |
| matching | left_items[].label / text、right_options[].label / text | 左右角色、item_id / option_id、pairing、allow_left_unmatched、has_distractors；无正确配对 |
| ordering | items[].label / text | item_id 与显示顺序；不当正确答案 |
| sentence_breaks | text | 字缝在冻结 text 的 code point 上；引用仍用 UTF-16 offset |
| table | column_headers[]、row_labels[] | cells[].row/col→slot_id 指向同 part 子槽，子槽本身也完整投影；不虚造 cell 文本 |
| numeric | unit_hint | precision |
| blank | unit_hint、answer_shape 的 unit / binding / axes / variables | format、max_chars、完整 canonical answer_shape version/value/notation；这是公开输入声明 |
| open_response | accepted_evidence[].allowed_mime_patterns[] | max_chars、evidence_required、允许提交的 kind/max_bytes/security_scan；不把允许上传误认成题目含未读媒体 |
| text / formula | 无额外自由文本；仍保留 placement.label | max_chars / math_preview / notation |

passage 定位使用 `/parts/<part>/slots/<slot>/<field path>`，part/slot/axis 名采用 JSON Pointer 转义；数组下标只定位原文字段，稳定身份和归属始终从 slots 对象读取。每个 quote 仍由现有确定性验证逐字核对 UTF-16 start/end，版本与权限来自同一次冻结。候选与每份 anchor 都传 parts/slots、revision/digest 与对应 locator 前缀，不能混用身份。

完整 slots 的序列化长度与原文 passages 共用原 90000 字符预算，重复发送的文本也计入；候选与 anchors 的 slots/文字合并受原 120000 输入预算，单锚仍受 50000 上限。结构放不下、原文截断、未知/畸形字段、无槽位、非法身份/关系、文本未读全、缺材料或任一公开文字字段中的 Markdown/HTML 媒体未读，都留下明确 blocker。已知所属 part 的局部缺证阻断该 part；无法绑定 part 或全图关系错误保守阻断整个任务。所选 part 有 blocker 时，现有 verifier 强制所有 checks 和 joint unknown，不能仅引题干绕过，matched 不增加。完整无媒体的普通槽位不会因此永久 unknown。

策略常量单行经父定向释放为 `bank-semantic-v2-20261022`，使旧 adapter 生成的快照沿已有校验失效，不更改 wire contract_version、恢复逻辑、阈值或 serving/scoring/paid。

新增验收 TEXT（均 NOT_RUN）：以同版 select 关系项、select 字缝、旧 matching/ordering/sentence_breaks/table 的必要条件请求，逐项观察 literal quote 与结构关系同时存在；对选项图片、畸形坐标/child 引用、槽位超预算，观察所选 part 的 checks/joint unknown 且 matched 不增；以无材料且槽位完整的纯文字题观察没有无故 blocker。所有 tests/cases/fixtures/断言均未改，不执行此 TEXT。实际模型质量仍待有授权的运行验证。

### R1 修复后的静态回执

所有重活经同一 heavy.sh 串行执行、全机两槽、Node≤3072；未重复 install。

| 命令 | exit | 证据 / 日志 |
| --- | --- | --- |
| `pnpm typecheck` | 2 | 仍为 29 条，全部在未改的 bank-tools.db.test.ts；无新增产品类型错误。`/tmp/yuk1448-r1-typecheck-final.log` |
| `pnpm exec tsrs --noEmit -p server/start/tsconfig.json` | 0 | 主 typecheck 第一项目失败后另跑现有 Start 检查。`/tmp/yuk1448-r1-start-types.log` |
| `pnpm lint` | 0 | 181 warnings，与初版相同；新模块格式检查无诊断。`/tmp/yuk1448-r1-lint.log` |
| `pnpm build` | 0 | web/Start/server/worker/migrate 均完成；没有运行产物。`/tmp/yuk1448-r1-build.log` |
| `audit:task-census` | 0 | 60 注册 / 58 调用 / 2 兼容 / 75 call sites。`/tmp/yuk1448-r1-task-census.log` |
| `audit:tool-params` | 0 | 所有枚举工具面零 violation。`/tmp/yuk1448-r1-tool-params.log` |
| `audit:capability-boundaries` | 0 | totals 384/0/36，R1 没有新增共享边界登记或豁免。`/tmp/yuk1448-r1-boundaries.log` |
| `audit:architecture-deepening` | 0 | main 新增三条登记完整保留；60 TaskSpecs，1092 pass-through sites / +0。`/tmp/yuk1448-r1-architecture.log` |
| `audit:model-source` | 0 | `/tmp/yuk1448-r1-model-source.log` |
| `audit:provider-lanes` | 0 | `/tmp/yuk1448-r1-provider-lanes.log` |
| `audit:schema` | 0 | 仅源码写入 census，不等于完整迁移。`/tmp/yuk1448-r1-schema.log` |
| `git diff --check` | 0 | 本次没有改 read-bank、core response schema、呈现组件、SQL/schema、backup/restore 或 tests/cases/fixtures/测试配置。 |

各检查 exit 汇总 `/tmp/yuk1448-r1-check-exits.log`。DB/TEST/Docker/provider/browser/runtime/付费/后台/部署、39/K7/owner 盲题、槽位验收 TEXT：全部 NOT_RUN；没有 actual model output。修后 exact-head CI 不观测/不轮询，独立唯一 R2、迁移 metadata、Linear 与 merge 均交父。本片未交义务仍归原 YUK-1448，没有新增独立 follow-up 或新票。

### R2 残留与父定向修复

唯一 R2 对 `2e7df34e` 保持 CHANGES_REQUESTED：旧 choice 的 options 在 read_bank 输出 schema 中先被剥除未知字段，之后 strict 校验不能识别原文损失。原 R2 结论保留，不开启第三审。

父在 freezeBankCandidate 的同版授权读取成功后，按公开 slot_id/part_id 寻找该 immutable revision 的唯一原始 choice slot，并用 canonical ResponseOption.strict 校验未被 reader 剥除的 options。身份不匹配、未知字段或畸形结构给所属 part 留 blocker；无法绑定 part 时全局阻断。原始 revision 仅用于发现损失，不进入模型输入，不扩大 read_bank 权限或改变其 wire。完整授权投影仍走现有 slots/passages；既有选择 part 的 blocker 传播强制 checks/joint unknown，anchor 同样不能作为完整证据使用。

策略变为 `bank-semantic-v3-20261022`，此前 v1/v2 核验快照沿现有 policy 比较 stale。此修复不改变题目评分/准入/paid、测试或迁移登记。父的静态检查另记真实结果；DB/provider/模型输出与畸形槽位验收仍 NOT_RUN，不以源码推演替代运行验证。

父实际检查：typecheck exit2，仍29条且只在旧 bank-tools.db.test.ts；lint 初次 exit1 为新增三元表达式折行，修正后 exit0/181 warnings；build exit0，后续仅上述折行与文档改变。命令均经既有 heavy 限流串行，原始日志在仓库外 `tlp-status/review/stage1-yuk1448-search-semantic-20261022/parent-r2-*.log`。父定向读通 raw revision → strict options → part/global blocker → checks/joint unknown 与旧策略 stale，确认残留的源码修法；这不是第三轮独立审查，原 R2 CHANGES_REQUESTED 不改写。最后实际 main/0133 metadata 的组合仍待原132顺序及owner测试许可，不能合入或部署。
