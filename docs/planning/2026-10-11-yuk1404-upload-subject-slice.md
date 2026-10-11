# YUK-1404 上传科目信号 — 实施切片证据

实施树：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-merge-preview-notation`，
branch `fix/yuk-1404-merge-preview-notation`，base `dbbb1f8c`（main12c740/UI1663 已并入）。
设计依据：`docs/planning/2026-10-11-yuk1404-explicit-upload-subject.md`（FULL 方案，协调者已批准）。

## 范围内变更（本切片 owned files）

| 文件 | 变更 |
|------|------|
| `src/capabilities/ingestion/api/contracts.ts` | `CreateIngestionSessionBody` 增 `subject_id: z.string().nullable().optional()` |
| `src/capabilities/ingestion/api/sessions.ts` | POST 解析后、任何 DB 写之前：非空 `subject_id` 经 `resolveSelectableSubjectId`（`src/subjects/profile.ts:349`）解析别名并校验当前可选；解析失败 → `ApiError('validation_error', …, 400)`。canonical id 以 `learnerSelectedSubjectId` 转发；omitted/null → `null`，照常上传 |
| `src/server/session/ingestion.ts` | `InitiateUploadParams` 增 `learnerSelectedSubjectId?: string \| null`；`initiateUpload` 在原事务内把它写进 session 绑定的 `source_document.provenance.learner_selected_subject_id`（仅非空时写键；无新表/列，不触碰 `scope_knowledge_ids`） |
| `src/kernel/proposals/presentation.ts` | `loadIngestionSessionNotations` 改为 explicit-first：先读 session 绑定 source_document provenance 的显式信号；非空信号用 resolvable-all registry（`resolveKnownSubjectId`）解析——retired-but-registered 保留原 notation，彻底不可解析 → `null` 且**不走**派生回退。无显式信号（键缺席/null/非字符串/legacy）的 session 保持既有 all-linked registered/unanimous 派生回退，逻辑未变，仅作用于无显式信号的子集 |
| `src/kernel/proposals/presentation.ts`（cleanup） | UI1663 并入后 `technical_details` 已无消费者。全源核实（rg：仅本文件 producer + shell contracts + generated client）后移除：`ProposalPresentation.technical_details` 字段、`ProposalPresenter.details`、20 个 presenter 的 `details` 项、`technicalDetails`/`defaultTechnicalDetails`/`difficultyTechnicalDetails`/`relearnTechnicalDetails` helper。`estimatedDifficulty`/`estimatedMasteryTrend`/`recordOf` 仍被 summary 使用，保留 |
| `src/capabilities/shell/api/contracts.ts` | `ProposalPresentationResponseSchema` 移除 `technical_details` |
| `src/ui/lib/api-schema.generated.ts` | `pnpm gen:api-client` 机械再生成：两处 create-session 请求体 +`subject_id?: string \| null`；两处 proposal presentation 响应体 −`technical_details` |

不变量：`createIngestionSessionResource` 的 resource/Location/error/legacy 语义未动
（canonical wrapper 与 legacy deprecated wrapper 均直接复用 POST，行为随 body 合同加性扩展）。
无 KC/attempt/auto-tag/auto-enroll/goal/job 改动；无新导出（`ingestion/public.ts` 未改）。

## 关键语义裁决（与设计 §7/§11 对齐）

1. **写侧**：只有"请求显式给出且通过 selectable 校验"才写
   `learner_selected_subject_id`（canonical id）。omitted/null/空串（空串解析失败 400）
   一律不写键 → 与 legacy 行字节同形，派生回退对两者等同可用。
2. **读侧显式优先**：显式会话的 notation 只由存储信号决定——数学科目上传后、
   尚无任何已收录题即得 katex；已收录题也不改变它（派生路径对显式会话永不执行）。
   存储信号后来不可解析（如自定义科目被删）→ `null`，不猜、不回退、不 general。
3. **读侧回退保留**：仅无显式信号的会话走既有 conservative 派生回退
   （全部关联题 unanimous 且 registered 才解析；混合/未知/无关联题 → null）。
   retired-but-resolvable 的渲染语义复用 registry resolvable-all 集合，与
   `resolveSubjectRenderNotation` 既有合同一致。

## 验证（真实 exit code，本机 Node v26.10.0）

| 命令 | 结果 |
|------|------|
| `pnpm gen:api-client` | exit 0；generated diff 仅上述 4 处机械变更 |
| `pnpm gen:postman` | exit 0；`postman/` 无 diff（api-endpoints.json 本就不含 ingestion 路由，确定性 no-op） |
| `pnpm typecheck`（`tsc --noEmit` + `tsc --noEmit -p server/start/tsconfig.json`） | exit 0 |
| `pnpm lint` | exit 0（174 warnings 全部位于非 owned 文件的既有基线；对 5 个 owned 源文件逐一 grep：0 命中，exit 1） |
| `pnpm build`（server.cjs / worker.cjs / migrate.cjs） | exit 0 |
| `pnpm audit:api-client-usage` | exit 0（"every capability *-api.ts uses generated operations"） |
| `pnpm audit:api-contracts` | exit 0（173/173 declared, 0 legacy, 163 OpenAPI paths） |
| `pnpm audit:api-client`（commit 后复跑，true exit 直接捕获） | exit 0（regenerated client 与已提交合同一致；commit 前运行必然因未提交的 generated diff 报 ELIFECYCLE 1，属预期顺序非真实失败） |

## 验收与测试边界

本切片未新增持久化回归测试，默认测试限制仍按五类不变量执行。非法科目/资产的原子拒绝由父会话使用真实创建 handler 和隔离数据库验证。子任务被禁止执行 DB/container/runtime，不等于禁止编写父会话会执行的不变量测试；此前“未执行测试违反合同”的解释不成立，已更正。

首次父验收固定 `8b02a2a0da0468c1f04cd643c80ea57422d6cced`、Node 24.19.0，仓库外封存 `/tmp/yuk1404-upload-8b02-parent-01/seal.json`。矩阵断言通过，但 console 明细未被 Vitest 日志捕获，解析出的 `actual-outcomes.json` 是空数组；这份原件保留，只证明测试结果，不能作为响应载荷证据。九次合成请求验证 unknown/empty/general subject 和 missing asset 返回400，来源/会话/业务回执完整 before/after 相等；math、wenyan alias、省略和null返回201及正确Location；canonical provenance和刷新读取一致；实际math草稿尚无已收录题时notation=katex；历史不可解析非空信号返回null；legacy200复用同一创建逻辑。读取前后来源/会话/回执未变，provider_attempt和ai_task_runs均0。单个实际验收矩阵通过，不写成九条持久化测试。

补捕获固定正常合入 main07c 的 `3040e336d88c11e901bff92384bb7a6e64448881`，五个产品源文件与被审8b02完全相同。重新使用真实 handler 和新 disposable PG，把 Response、实际存储行及 presentation 直接写入仓库外文件，不依赖 console。单矩阵通过，`/tmp/yuk1404-upload-3040-parent-02/actual-outcomes.json` 含32条记录：9个实际响应（400×4/201×4/legacy200）、4组存储行、10次预览读回及9项断言后结果。capture seal 为 `a0523703b2bc3b654ae81ec9c5fe4fe44db639c0fbe511c4dedabcc9ca45e5ba`，原首次结果未改写。新窗原四TEST/release parity、owner token与锁释放再次核验通过。

自身 INITIAL review：opencode / GLM5.3 max，fixed8b02 vs main12c真实8文件diff，NONE P0/P1。任务 `yuk1404-upload-subject-own-initial-review-glmmax-20261011-v1` completed/noPending。检查optional/null、selectable验证在写之前、canonical/legacy共享事务、显式优先/保守回退、清理消费者和生成合同。source-only，无审查者运行/UI证据；custom/retired/mixed场景未运行。正常main07c合并后5个owned产品源文件字节相同，generated client随上游stale合同机械组合并另过生成审计。

父 Node24 typecheck/lint/build/API-client/API-contract审计通过。隔离PG teardown后原四TEST id/image/start/health和releasehash逐项未变，owner token核验后共享锁释放。无TEST学习者数据写、provider调用或新增支出。这是实际handler和DB证据，不是网络RPC、blob/OCR、浏览器公式或真实照片质量证明。

## 限制与移交

- 上述真实创建/DB矩阵已由父会话串行完成。真实 UI 公式可读性与可跳过选项发送仍归 Opus；custom/retired/mixed关联题场景目前仅源码复核，不冒称本矩阵已运行。
- UI 发送 `subject_id` 的可跳过选项由 Opus 线实施（本切片未改任何 UI 文件）。
- Start 路由/typed operation extraction/wrappers/boot/DBOS 未触碰（迁移线边界）。

## 未来工作（已记录，未实施）

若录入 agent 对照臂胜出：agent 可为未知/混合科目会话提出**逐题**科目提议，必须标注
"推断"、经学习者一次确认才生效、复用既有提议/确认机制；学习者显式选择始终优先，
推断不得静默覆盖；不从题面或公式形状直接启用 math notation。属后续 agent 切换切片，
本次上传信号、预览与 UI 合同均未实施它。
