# YUK-1404 — block_merge 预览 notation 只读字段（实施证据）

日期：2026-10-11 · 分支：`fix/yuk-1404-merge-preview-notation` · base：`7a826a37d`
工作树：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-merge-preview-notation`

## 交付物

`ProposalPresentation.block_merge.notation: string | null`（wire + 内核投影同步）。
为空条件（一律 null，绝不推断 math / 不用默认 math profile）：

- ingestion_session_id 解析不到 `learning_session(type='ingestion')` 行（含同 id 他
  type 行——会话 id 的语义就是 ingestion 会话）；
- 会话没有任何可解析科目的题（含 auto-enroll observe 模式：不落 question，诚实
  null）;
- 科目未注册（registry 无此 profile）。

别名（wenyan → yuwen）、custom（`subj_*` 水合后）、retired-but-resolvable：走
canonical registry `resolve()` 语义，保留原 profile 的 `renderConfig.notation`
（retired 只改 meta，`resolve()` 不过滤 retired；见
`src/kernel/read-models/subject-resolution.ts` 的
`resolveSubjectRenderNotation` doc 注释——它就是为「历史题保留原渲染语义」抽的）。

## 科目解析链（为什么这样解）

**已核实事实**（本树逐一验证）：

1. `ingestion_session` 表已 DROP；会话真身在 `learning_session(type='ingestion')`
   （`src/db/schema.ts:358-361` 注释 + `src/db/schema.ts:2345-2401` 全列清单——
   **没有 subject 列**；drizzle 迁移史 `ALTER TABLE learning_session` 仅
   artifact_id/scope_knowledge_ids/placement_leanings/placement_pace/
   agent_sdk_session_id）。
2. 「subject is a derived view, never stored on learning_session」——
   `src/capabilities/ingestion/server/auto-enroll.ts:310-316` 与
   `src/capabilities/ingestion/server/import-completion.ts:165-170` 原文注释。
3. 会话→科目的确定性落点是其题目：auto-enroll（`auto-enroll.ts:631-644`）与
   人工 import（`import-completion.ts:401-413`）写 question 时都 stamp
   `metadata.ingestion_session_id`，question 带真实 `knowledge_ids`。
   `import-completion.ts:373-377` 已有同款 metadata jsonb 查询先例。
4. 仓库 canonical 科目桥（BR-4）：knowledge_ids[0] → getEffectiveDomain →
   subject id，批量为 `batchResolveSubjectDisplayIds`；notation 出料口为
   `resolveSubjectRenderNotation`（`paper-detail.ts:289-299` 是同链先例）。

**实现链**（`presentation.ts` `loadIngestionSessionNotations`，全批量）：
去重 sessionIds → 分块 IN 查 `learning_session` 存在性（未知会话保持 null，即使
有孤儿 question metadata 仍引用它）→ 分块 IN 查
`metadata->>'ingestion_session_id'` 的 question（`ORDER BY created_at, id` 稳定序）
→ `batchResolveSubjectDisplayIds`（内部按唯一 first-knowledge-id 去重树爬）→
每会话取稳定序中**首个**解析出科目的题 → `resolveSubjectRenderNotation`（未注册
串经 registry general 兜底出 notation null，绝非 math）。两个 helper 均为现状使
用，零扩展、零 registry 语义改动。

## 变更文件

- `src/kernel/proposals/presentation.ts`：`block_merge` 增 `notation`；新增
  `loadIngestionSessionNotations`（复用既有 `chunksOf`/`IN_QUERY_CHUNK_SIZE`）；
  `loadProposalPresentations` 收集 block_merge session ids 并行批量解析。
- `src/capabilities/shell/api/contracts.ts`：wire schema 增
  `notation: z.string().nullable()`。
- `src/ui/lib/api-schema.generated.ts`：`pnpm gen:api-client` 机械再生成（仅两处
  `+ notation: string | null`，inbox 页 + 单提议响应）。
- 本证据文档。

`ProposalBlockPreview` 签名、真实计数、renderer-safe 摘要、continuity 标签、
admission/confirm_lossy 政策：零改动（offline 断言钉死键集不变）。

## 离线证据（真实生产函数，无 DB/网络/provider）

脚本：`/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/yuk1404-notation-evidence.ts`（仓库外）
日志：同目录 `yuk1404-notation-evidence.log`（exit 0，
`ALL YUK-1404 NOTATION OFFLINE EVIDENCE ASSERTIONS PASSED`）。

走真实 `loadProposalPresentations`（stub drizzle select 链，沿用 #1661 lane 先例）
+ 真实 `batchResolveSubjectDisplayIds` / `resolveSubjectRenderNotation` / 真实
`SubjectRegistry`。关键断言：

| 用例 | 期望 | 结果 |
|---|---|---|
| 已 enroll 的 math 会话（首题空 knowledge_ids 被跳过，次题经 child→parent 爬到 domain 'math'） | `'katex'` | ✅ |
| domain=wenyan（别名） | `null`（canonical yuwen） | ✅ |
| domain=ghost_subject（未注册） | `null`（registry general 兜底，非 math） | ✅ |
| 会话存在但无任何 question | `null` | ✅ |
| 同 id 但 type='review' 行 | `null`（非 ingestion 会话 = 未知会话） | ✅ |
| 会话行缺失 + 孤儿 question metadata 仍引用 | `null` | ✅ |
| 批量性 | learning_session 查询 1 次；question-by-session 1 次批查；未知/错型会话不进该批 | ✅ |
| 形状 | `ProposalBlockPreview` 键集不变；`block_merge` 恰增 `notation` | ✅ |
| registry 纯语义 | math/physics→'katex'；yuwen/wenyan→null；mathematics 别名→'katex'；null/未注册→null；注册 custom（notation 'katex'）保留且在 resolvable 集 | ✅ |

## 本地门（全部本树 frozen offline install 后执行）

| 命令 | exit |
|---|---|
| `pnpm install --frozen-lockfile --offline` | 0（7.2s） |
| `pnpm typecheck` | 0（改动后复跑一次仍 0） |
| `pnpm lint` | 0（174 条存量 warning 与 #1661 基线一致；改动文件 0 error/warning） |
| `pnpm build` | 0（web/start/server/worker/migrate 全产出；migrate 5.7mb 与基线一致，无 SDK parser 混入） |
| `pnpm gen:api-client` | 0，增量恰 2 行 |
| `pnpm gen:postman` | 0，零 diff（33 folders/87 paths/94 requests） |
| `pnpm audit:api-client` | 提交前 diff 非空 = 预期红（重生成为确定性同 blob，随本提交落库后即绿；同 #1661 lane 先例） |
| `pnpm audit:api-contracts` | 0（173/173 declared） |
| `pnpm audit:capability-boundaries` | 0（0 deep cross-capability imports） |

未跑 full `pnpm test`（规约：exact-head CI Gate 负责）；未新增测试（不触五类不变
量；DTO/读侧展示合同由上述离线证据覆盖）。无 DB/容器/runtime/provider/浏览器调
用；无 UI/Start/boot/DBOS/迁移/新抽象；无 push/PR/merge/Linear。

## 边界与未决

- observe 模式（不落 question）下 notation 恒 null——这是「无科目信号不猜」的诚
  实空值，非缺陷；enroll 模式（写 question+knowledge）自动可解析。
- `batchResolveSubjectDisplayIds` 内部 getEffectiveDomain 为按唯一 id 的爬链小查
  询（每页 ≤ 会话数、跨提议去重）——与 paper-detail 同款批量语义，未改 helper。
