# 备题员 web 文本供题闭包（YUK-1468）

服务 ADR-0069 D1/D4、YUK-1594 已锁方向，交付阶段为「按真实时间安排」。本片只处理现役 `supply_execute → plan-executor.runWebRoute`。源码候选不等于产品运行验收，YUK-1468 保持 In Progress。

## 责任与事实

`question-supply/web-supply.ts` 是需求内完整操作，拥有获取 fence、完整候选回执、唯一提交、publication 身份绑定、核验/serving 对账及恢复；不新建表、bus、registry 或 agent。`runWebRoute` 实际调用它；`verify-dispatch-recovery` 在既有启动/夜间队列排空 verify outbox 后调用同一恢复操作，经 Practice public 的 lazy 完整操作接线。

网页 URL 与图片直链不混用。SourcingTask 在原 Exa 读取/轮次/时限内寻找完整文本来源，正文不足继续换源；兼容字段 `image_candidates` 只携带内部来源受阻线索。需求 owner 不创建 proposal、不自动 accept 旧 proposal、不下载图片、不启用后台 VLM。原 ingestion 下载器 SSRF、DNS pin、每跳校验、MIME/大小/时限与 manual_rescue_only 均保持。

候选完整保存 `SourcedQuestion`（含 extract、原 URL、typed parts）及原 query plan、fetched time、content/extract digest、producer `ai_task_runs` 身份。domain 工具与 runner 使用同一 canonical producer task ID；一般候选工具仍创建独立 producer ID，不复用外层 Copilot run。

需求 key 优先复用 `SupplyTrace.demand_id`；无 trace 的 planner 项复用原 demand event ID。trace/target/claim/KC/subject/count/kind 等意图以 canonical fingerprint 固定。短需求事件事务中 advisory lock + sequence CAS；所有模型/网络/submit 在锁外。新状态只追加既有 event，不改历史事件与题行事实。

每个候选只经真实 `submit_question` 工具 owner，保留来源/KC/去重、flat/typed 原 writer、verify intent 及 paid/admission 算法。发起提交前持久化 request fence；同 candidate 的原 submit receipt 为恢复依据，不把 best-effort canary 当回执。flat receipt 的提交后窗口按 owner 本轮批准的精确共享 hunk 收入原提交事务。正常返回保留实际派发观测，崩溃重放只返回 durable pending receipt；不把未知派发伪报为已入队。typed 首次 publication 原有 receipt 已同事务。实际 flat 写事务先取原 request advisory lock、重查原 fingerprint claim，再进入原 beforeIngestionWrite/source/canonical/root 锁序；同指纹重放、异指纹冲突分支均不落题或派发。前序 exact/source merge 仍在此事务外，不宣称整条旧链原子。恢复通过提交 owner 的 readCandidateSubmitReceipt，复用原 facade 的 findSubmitReceipt、原 parser/fingerprint/outputSchema；冻结完整原请求，匹配内容后才认领回执，不复制 codec。

## 成功、失败与恢复

| 事实/窗口 | 同需求行为 |
| --- | --- |
| 获取前接纳 | 锁内只接纳一次；placement authority 未映射、deadline 已过或预算为零，明确 blocked |
| 获取进行中但没有候选回执 | 保留 acquiring/unknown fence，不再次抓取或重付；需原运行对账 |
| 只有图片/缺正文 | 保留 URL/原因/query plan，blocked；不发用户技术任务 |
| 获取回执已落，未提交 | startup/nightly 或原 job 重投读取同候选，按原 request 提交；不重抓 |
| 提交发起但回执未见 | 保留 submitting/unknown fence；恢复只读原 receipt，不重发未知副作用 |
| receipt 已落，owner 尚未记录 | 读原 receipt，找该提交的真实 publication event，绑定 group/revision/digest/generation |
| verify 入队失败 | 原 verify intent/outbox 恢复；不获取或重生成 |
| source verify 通过、admission 未完成 | verifying，供给满足量为零 |
| 同 base 的 admission resolved revision | 要求 publisher 的 paid receipt provenance 指向原 base，且当前 serving 真可用 |
| source/admission 失败、withdrawn、非需求可用或 revision 被无关编辑替换 | blocked；保存原结果，不降低门或生成新题遮盖 |
| 原 revision（或其已证明的 paid resolved revision）可供完整组 | 同一 repeatable-read 快照读 serving、KC、kind、allowed uses、pool availability、墓碑/expiry/exposure、source verification；足量才写 fulfilled |

`acquired` 对本 web 路由只表示真实 serving 数，`committed` 表示提交题数；executor item/aggregate 的完成事件仍仅表示执行结束。本 web 路由接管后不再落入 quiz_gen 掩盖失败。serving 满足是记录时点的事实，不保证未来不被撤回。

控制仍是原 SourcingTask 8 轮/120 秒和现有 provider 运行协议；本片只发起一次获取，不增加重试预算或放宽已有付费边界。非零金额上限沿原模型执行能力，不新增成本估计或假定硬金额 fence；实际费用未知不当作零费用。没有迁移 jyeoo 租约/预算/高中范围。placement 本片明确 blocked，不能声称其 authority 映射完成。

## 保留义务与验证边界

历史 inbox 精确移交、图片/VLM 权限映射、所有 quiz_gen consumer 与旧 paid unknown 对账后整体退役、refill/placement/全来源、来源失败自动 repair 的更广战术、原坏题全链质量证据与真实学习效果，仍归 YUK-1468/1594。不开第二总纲，不以1594文档 Done 宣称产品完成。

原坏题 `itemqdp4zs6gs3811gqyyf0bhjkn → questionqxheyf9qkhyu5ofkuvgiy8za` 的 question/source/attempt 不改。未取得 full contract/key/verifier/admission 原件，不能用只读 GET 摘要补作者意图或对某门定罪，也不重生成。

本轮 tests 0 修改 / 0 运行；无网络抓题、provider、业务 HTTP、DB/SQL、Docker、paid、部署、UI runtime、hashseal。静态 typecheck/lint/build/audit 的精确 exit 与日志在外部交付目录，最终 handoff 列明；这些不构成实际供题/恢复验收。

静态交付：typecheck、lint、build、capability-boundaries、architecture-deepening、provider-lanes、draft-status-reads --strict、task-census、question-writers 最终均 exit 0；lint 168 warnings。最初格式/ledger/consumer 行号的失败日志保留，后续通过不改写原失败。原生边界量为160/0/24、两个新 kernel 依赖；submit owner 原生尺寸1314→1382。完整日志、每门 exit、四条并发源码因果与差量交父，目录 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/review/yuk1468-web-supply-closure-20261030`。独立 R1 / exact-head CI / 运行验收均由父后续执行，本 writer 未运行。
