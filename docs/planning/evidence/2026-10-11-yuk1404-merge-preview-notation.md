# YUK-1404 — block_merge 预览 notation 只读字段（实施证据）

日期：2026-10-11 · 分支：`fix/yuk-1404-merge-preview-notation` · base：`7a826a37d`
（follow-up 修订：parent INITIAL 源审后，改为「全体 linked question 一致才解析」的保守共识语义，并落 UI 学习者措辞）
工作树：`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1404-merge-preview-notation`

## 交付物

`ProposalPresentation.block_merge.notation: string | null`（wire + 内核投影同步）。

**共识语义**（保守读；同会话内任何一颗不定项都不猜）：

- `ingestion_session_id` 解析不到 `learning_session(type='ingestion')` 行（含同 id 他
  type 行）→ null；
- 会话的所有 linked question（`metadata.ingestion_session_id` stamp 的题）必须**全部**
  解析到**同一个已注册 canonical subject id**，缺一不可：
  - 任一题 unresolved（无 `knowledge_ids[0]` / 爬不到 effective domain）→ null；
  - 任一题 unregistered（domain 落在 registry 别名表之外，bridge 回传裸 normalize 串）
    → null（`resolveKnownSubjectId` miss，**按构造为 null**，不经 general 兜底）；
  - 题目间 canonical subject 不一致（混合科目 ingestion，如 math+yuwen）→ null——防
    止 math 的 KaTeX 泄漏到文科题面的散文渲染；
- 会话无任何 linked question（auto-enroll observe 模式、draft-only 采集不落 question）
  → null（无科目证据，诚实未知）；
- 一致命中时经 `resolveSubjectRenderNotation` 取该 canonical profile 的
  `renderConfig.notation`（general/yuwen 如实为 null，math/physics 为 katex）。

别名（wenyan → yuwen）、custom（`subj_*` 水合后）、retired-but-resolvable：走
canonical registry `resolve()` 语义，保留原 profile 的 `renderConfig.notation`
（retired 只改 meta，`resolve()` 不过滤 retired）。

### 已知局限（如实记录，非已完成能力）

draft-only / observe 采集**没有持久化的科目证据**（不落 question），notation 恒为
null → 学习者看到纯文本。**这不是一条已经能用的草稿数理渲染路径**：在存在真实的
科目证据消费端（例如 draft 侧落科目信号）之前，本字段对这类会话就是诚实的
null/纯文本。把「unknown 变成 fallback-profile 知识」是被明确拒绝的反模式。

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
   `resolveSubjectRenderNotation`（`paper-detail.ts:289-299` 是同链先例）；
   「已注册 canonical」判定用 `resolveKnownSubjectId`（registry 既有导出，
   无新 helper）。

**实现链**（`presentation.ts` `loadIngestionSessionNotations`，全批量）：去重
sessionIds → 分块 IN 查 `learning_session` 存在性（未知会话保持 null，即使有孤儿
question metadata 仍引用它）→ 分块 IN 查 `metadata->>'ingestion_session_id'` 的
question（`ORDER BY created_at, id` 稳定序）→ `batchResolveSubjectDisplayIds`（内部
按唯一 first-knowledge-id 去重树爬）→ **逐会话共识**：每题结果经
`resolveKnownSubjectId` 规约成 canonical 注册 id（unresolved/unregistered 规约为
null），任一题 null 或两题 canonical 不一致将会话判 null；一致会话才调
`resolveSubjectRenderNotation(canonical)`——该 helper 因此**只会被以已注册
canonical id 调用**，永不以 null/裸串调用，fallback profile 语义进不了本路径。
共识对题序不敏感（先毒化后跳过）。两个 helper 均为现状使用，零扩展、零 registry
语义改动。

**批量界（更正此前文档的说法）**：`batchResolveSubjectDisplayIds` 内部的
getEffectiveDomain 树爬按**唯一 linked question knowledge id**（各题
`knowledge_ids[0]` 去重）定界，**不是**「每页 ≤ 会话数」——同会话多题共享同一
knowledge id 时只爬一次；跨提议的题在同一批内再去重。断言见离线证据。

## 学习者措辞（block_merge 面，同源 `presentation.ts`）

按 UI 请求去除内部术语 块/题块（仅 block_merge 的 title/summary/fallback/
blockPreview 标签；note-update 等非 block_merge 面的既有「内容块」措辞不在本次范
围）。页码保持一位起始（one-based）；continuity/人话化/数学安全截断 cap 全部不动；
`technical_details` 字段保留（PR #1663 仍 OPEN，等消费端合入后再删）。

| 位置 | 旧 | 新 |
|---|---|---|
| 表格 title（`proposalDisplayTitle`） | `合并 N 个被切断的题块` | 有并入：`合并 N 段题目内容`；无并入：`合并题目` |
| 表格 summary 动作 | `保留 1 块，并入 N 块` | `保留这部分，合并其余 N 部分` |
| 投影 title（DB 行就位） | `合并 N 个被切断的题块` | `合并 N 段题目内容` |
| 投影 title（仅 primary 无并入） | `检查被切断的题块` | `合并题目` |
| 投影 title（primary 缺失） | `检查题块合并提议` | `检查题目合并提议` |
| 投影 summary | `保留 1 块，并入 N 块` / `候选题块已变化，请重新检查` | `保留这部分，合并其余 N 部分` / `候选内容已变化，请重新检查` |
| blockPreview 位置标签 | `第 N 块` | `第 N 部分`（后缀 `题号 X`/`第 N 页` 保留，页码一位起始） |

## 变更文件（follow-up 增量）

- `src/kernel/proposals/presentation.ts`：`loadIngestionSessionNotations` 改共识语
  义（+`resolveKnownSubjectId` 注册判定）；上述措辞替换；接口/实现注释收窄。
- 本证据文档。
- `src/capabilities/shell/api/contracts.ts` / `src/ui/lib/api-schema.generated.ts`：
  **零增量**（notation 已在 base 提交 55a20409a 落好；措辞是运行期字符串，不进
  schema——`pnpm gen:api-client` 复跑零 diff 为证）。

`ProposalBlockPreview` 签名、真实计数、renderer-safe 摘要、continuity 标签、
admission/confirm_lossy 政策：零改动（offline 断言钉死键集不变）。

## 离线证据（真实生产函数；DB 端口为显式假桩，无 DB/网络/provider）

脚本：`/private/var/folders/bt/rcf5s7tx3s93g3dz0046y96w0000gn/T/opencode/yuk1404-notation-evidence.ts`（仓库外）
日志：同目录 `yuk1404-notation-evidence.log`（exit 0，
`ALL YUK-1404 NOTATION CONSENSUS + WORDING OFFLINE EVIDENCE ASSERTIONS PASSED`）。

drizzle select 链为内存假桩（fixture 见脚本头 **FAKE DB PORTS** 声明）——它证明的
是真实 `loadProposalPresentations` / `batchResolveSubjectDisplayIds` /
`resolveSubjectRenderNotation` / 真实 `SubjectRegistry` 的纯解析·共识·措辞逻辑，
**不构成任何 DB/runtime 证明**。关键断言：

| 用例 | 期望 | 结果 |
|---|---|---|
| 一致 math 会话（child→parent 爬 + 直连 root，两题同 canonical） | `'katex'` | ✅ |
| 一致 wenyan 别名会话（两题共享同一 knowledge id） | `null`（canonical yuwen，如实非 math） | ✅ |
| **混合科目**（math + yuwen 同会话） | `null`（不一致 → 纯文本，KaTeX 不入散文） | ✅ |
| **含 unresolved 题**（一题 math + 一题空 knowledge_ids；不再跳过） | `null` | ✅ |
| domain=ghost_subject（未注册） | `null`（按构造，不经 general 兜底） | ✅ |
| 会话存在但无任何 linked question（observe/draft-only） | `null` | ✅ |
| 同 id 但 type='review' 行 | `null`（非 ingestion 会话 = 未知会话） | ✅ |
| 会话行缺失 + 孤儿 question metadata 仍引用 | `null` | ✅ |
| 措辞 | title `合并 2 段题目内容`/`合并题目`/`检查题目合并提议`；summary `保留这部分，合并其余 1 部分`/`候选内容已变化，请重新检查`；位置标签 `第 1 部分 · 题号 5 · 第 3 页`（页码一位）；全部 learner 面字符串 0 处 块/题块 | ✅ |
| 批量性 | learning_session 查询 1 次；question-by-session 1 次批查；未知/错型会话不进该批 | ✅ |
| 树爬界 | 共享 knowledge id 的两题只爬 1 次（唯一 id 定界，非按题数） | ✅ |
| 形状 | `ProposalBlockPreview` 键集不变；`block_merge` 恰增 `notation` | ✅ |
| registry 纯语义 | math/physics→'katex'；yuwen/wenyan→null；mathematics 别名→'katex'；`resolveKnownSubjectId`：注册自解/别名归一/未注册→null/null→null；注册 custom（notation 'katex'）保留且在 resolvable 集 | ✅ |

## 本地门（全部本树 frozen offline install 后执行）

| 命令 | exit |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm lint` | 0（与基线一致；改动文件 0 error/warning） |
| `pnpm build` | 0 |
| `pnpm gen:api-client` | 0，零 diff（措辞不进 schema） |
| `pnpm gen:postman` | 0，零 diff（33 folders/87 paths/94 requests） |
| `pnpm audit:api-client` | 0（notation 已在 base 提交 55a20409a 落库；follow-up 零 schema 增量 → 重生成零 diff，直接绿） |
| `pnpm audit:api-contracts` | 0 |
| `pnpm audit:capability-boundaries` | 0 |

未跑 full `pnpm test`（规约：exact-head CI Gate 负责）；未新增测试（不触五类不变
量；DTO/读侧展示合同由上述离线证据覆盖）。无 DB/容器/runtime/provider/浏览器调
用；无 UI/Start/boot/DBOS/迁移/新抽象；无 push/PR/merge/Linear。

## 边界与未决

- observe / draft-only（不落 question）下 notation 恒 null——「无科目证据不猜」的
  诚实空值（见上「已知局限」），待真实的科目证据消费端出现；enroll 模式（写
  question+knowledge）自动可解析。
- 混合科目 ingestion 现在得到 null/纯文本，而不是首个可解析题的科目——这是接受
  的保守取舍（渲染少一次增强，好过错科增强）。
- `technical_details` 保留不动：PR #1663 OPEN，等消费端合入。
