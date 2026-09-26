// YUK-1043 — question 内容列写入方登记表（insert/update closure registry）。
//
// 统一发布链的闭包真相源：凡写入 question【判分输入列】（见
// scripts/audit-question-content-writers.ts CONTENT_COLUMNS）的 runtime 文件
// 必须在此登记。`pnpm audit:question-writers` 扫描 src/+server/+scripts/ 并
// 强制：
//   - 每个 content writer 有登记（status + tickets + note）；
//   - publisher-converged 文件必须【逐写点】在结构邻域内调用 publisher seam
//     （per-site 验证 —— 注册文件内新增绕过写口会被抓，复审 P1-7）；
//   - converged 登记必须对应真实 content 写入（防过期条目）；
//   - working-copy-pending 必须带 pendingClass（cutover / blocked-by:ticket）
//     —— 显式分类，不许笼统 pending（复审 P1-6）。
//
// 生命周期/投影列（draft_status / embedding / answer_class /
// canonical_content_hash / metadata / knowledge_ids / difficulty）的写入方
// 不需要登记 —— §2 矩阵明确区分检索投影与判分输入（后者才要求新 revision）。
//
// Disposition 语义：
//   publisher-converged  —— 该文件的每个 content 写点经统一 publisher seam
//                           同事务铸 revision（YUK-1043 已收敛）。
//   working-copy-pending —— 仍直写工作副本；pendingClass 说明为何现在不能
//                           收敛（cutover=YUK-1059 统一切换时收敛；
//                           blocked-by=等前置票）。grounding §2 矩阵行 = 本表行。

export type QuestionContentWriterStatus = 'publisher-converged' | 'working-copy-pending';

export interface QuestionContentWriterEntry {
  status: QuestionContentWriterStatus;
  /** 收敛/跟踪 ticket。 */
  tickets: string[];
  note: string;
  /** pending 条目必填（P1-6；复审裁决补 'deferred'）：'blocked-by:YUK-NNNN'
   *（真前置 —— 需要别的 lane 的契约）| 'deferred'（可做但选择不做，注明理由）
   * | 'cutover'（YUK-1059 统一切换时收敛）。 */
  pendingClass?: string;
}

export const QUESTION_CONTENT_WRITER_REGISTRY: Record<string, QuestionContentWriterEntry> = {
  // ─── 已收敛（YUK-1043：同事务 publishQuestionGroup*，per-site 验证） ───
  'src/server/questions/write.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'editQuestion：判分输入字段（题面/答案/选项/题型）变更 ⇒ 先锁组根再改子行、同事务统一发布（part 编辑锁序 question 根→子行）；archiveQuestion ⇒ 组根 archive 落 withdrawn，单 part archive ⇒ 重发组 revision（tombstone part 退出组契约）。',
  },
  'src/server/questions/sourced-draft-insert.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'web_sourced/jyeoo 新草稿 ⇒ 同事务铸首版 revision（admission withheld/unverified_rules；source_verify 通过后由 promote 重新发布为准入态）。',
  },
  'src/server/questions/parts.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'createQuestionPart ⇒ 同事务重发父组 revision（组契约含全部子 part）。',
  },
  'src/capabilities/practice/server/proposal-appliers.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: '三处内容写全部同事务发布：mistake_variant 接受 INSERT ⇒ 首版 admitted（manual+human，D9）；question_draft 接受 promote ⇒ admission 维度翻 admitted（manual+human）；acceptQuestionEditProposal 的 structured 编辑 ⇒ 新 revision（内容变更 ⇒ preserve 折叠 withheld，P1-5）。拒绝路径不发布（tombstone 语义不变）。',
  },
  'src/capabilities/ingestion/server/legacy-record-appliers.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'legacy dreaming 接受 INSERT ⇒ 同事务首版 admitted（manual+human）—— 可达接受路径不再是无契约写口（§2 矩阵行 13）。',
  },
  'src/capabilities/practice/server/tools/store-sourced-question.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'INSERT 走 sourced-draft-insert（converged）；图题事后富集 UPDATE（structured/figures/judge_override/multimodal —— 改变判分输入）之后同事务重发组 revision（复审 P1-6 补齐；纯 metadata 富集 digest 不变 ⇒ 幂等 noop）。',
  },
  'src/server/ai/solution-generate.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'reference/rubric backfill UPDATE 与统一发布同事务（§2 矩阵行 19）：新参考答案改变评分依据 ⇒ 新 revision + preserve 折叠 withheld（P1-5：旧 admission evidence 不越代适用）；ai_generated 来源标识已在 rubric.reference_solution_source 留痕。',
  },
  'scripts/seed-synthetic.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'seed 每题 INSERT 后同事务铸首版 revision（withheld/unverified_rules；synthetic 答案非官方 —— provenance system_proposed 如实入契约；幂等：digest 不变 noop）。§2 矩阵 seeds 行收敛。',
  },

  // ─── 待收敛（工作副本直写；显式 pendingClass，不许笼统 pending） ───
  // 注：quiz_verify / source_verify / verify-and-promote 的 promote 分支虽非内容列
  // 写者（只写 draft_status/metadata），但作为 §2 矩阵的 admission 时刻已在
  // YUK-1043 同事务接 publisher（见各文件 YUK-1043 注释），无需内容列登记。
  'src/capabilities/ingestion/server/auto-enroll.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'OCR/VLM 收录 INSERT ⇒ 同事务首版 revision（reference 缺失 ⇒ conversion_issue ⇒ withheld；学生作答走 attempt 事件，不进答案键 —— 复审裁决的先行落位）。',
  },
  'src/capabilities/ingestion/server/import-completion.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: '上传确认导入 INSERT ⇒ 同事务首版 revision（withheld —— 判分输入可契约化，无需等 cutover；复审裁决即刻收敛）。',
  },
  'src/capabilities/ingestion/server/image-candidate-accept.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'image_candidate 接受 INSERT ⇒ 同事务首版 revision withheld —— withheld admission 正是为「结构可判分、深度 grounding 未过」准备；source_verify（含 YUK-230 多模态复查）过后再 promote。',
  },
  'src/capabilities/ingestion/api/mistakes.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: '人工错题 INSERT ⇒ 同事务首版 revision（原错误作答不能成为答案键：在 attempt 事件保留；契约只承载题面/参考 —— 复审裁决即刻收敛）。',
  },
  'src/capabilities/practice/jobs/quiz_gen.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'quiz_gen 新题同事务铸首版 revision：composite 由 createQuestionPart 逐 part 发布（此处幂等 noop）；单题铸 v1。均 withheld/unverified_rules，quiz_verify promote 翻 admitted。',
  },
  'src/capabilities/practice/server/tools/question-author.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    pendingClass: 'deferred',
    note: '§2 矩阵 author_question 行【deferred，非 blocked】：接受路径已 converged（proposal-appliers）；未接受草稿不铸 revision 是产品选择（candidate 不冒充已发布题，草稿层无判分消费者），技术上现在就能做。cutover（YUK-1059）统一处置。',
  },
  'src/server/rehearsal/corpus.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1057', 'YUK-1059'],
    pendingClass: 'rehearsal-only',
    note: 'YUK-1057 隔离演练的 corpus seeder：故意用 legacy 工作副本形态写入 ephemeral 容器库（预切换快照），不触生产；cutover 后统一收敛（YUK-1059），演练库随容器销毁。',
  },
  'src/server/rehearsal/post-write.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1057', 'YUK-1059'],
    pendingClass: 'rehearsal-only',
    note: 'YUK-1057 演练的 post-cutover writer-seam 证明：对 ephemeral 库的受控写入，验证切换后写入路径；非生产路径，YUK-1059 收敛后演练改走 publisher。',
  },
  'src/capabilities/agency/server/conjecture/probe-lifecycle.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    pendingClass: 'blocked-by:YUK-1051',
    note: '§2 矩阵 probe 行：container-only；revision 与容器 occurrence 同事务绑定（§3.3）依赖 issuance 契约（YUK-1052 提交持久化 / YUK-1051）—— 相同文本不同 probe occurrence 不能被去重掉。',
  },
  'src/capabilities/copilot/server/teaching/materialize-ask-check.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    pendingClass: 'blocked-by:YUK-1052',
    note: '§2 矩阵 teaching_check 行：container-only 不免迁；教学 turn 与 revision/issuance 原子绑定依赖 pinned issuance（YUK-1052）。',
  },
  'src/capabilities/practice/server/intervention-diagnostics.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    pendingClass: 'blocked-by:YUK-1052',
    note: '§2 矩阵 intervention diagnostic 行（闭包修正后发现：map 回调体内的内容列曾被窗口截断漏检）：一次性 claim 与题目审核状态分离依赖 issuance claim 契约（YUK-1052）；教学材料版本冻结随 YUK-1051。',
  },
};
