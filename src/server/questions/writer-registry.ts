// YUK-1043 — question 内容列写入方登记表（insert/update closure registry）。
//
// 统一发布链的闭包真相源：凡写入 question【判分输入列】（见
// scripts/audit-question-content-writers.ts CONTENT_COLUMNS）的 runtime 文件
// 必须在此登记。`pnpm audit:question-writers` 扫描 src/+scripts/ 并强制：
//   - 每个 content writer 有登记（status + tickets + note）；
//   - publisher-converged 文件必须真的引用 publisher seam（防登记漂移）；
//   - converged 登记必须对应真实 content 写入（防过期条目）。
//
// 生命周期/投影列（draft_status / embedding / answer_class /
// canonical_content_hash / metadata / knowledge_ids / difficulty）的写入方
// 不需要登记 —— §2 矩阵明确区分检索投影与判分输入（后者才要求新 revision）。
//
// Disposition 语义：
//   publisher-converged  —— 该文件的 content 写入经统一 publisher 同事务铸
//                           revision（YUK-1043 已收敛）。
//   working-copy-pending —— 仍直写工作副本；在 cutover（YUK-1059）前必须收敛
//                           （grounding §2 矩阵行 = 本表行；全量切换后无原始
//                           内容双写口）。

export type QuestionContentWriterStatus = 'publisher-converged' | 'working-copy-pending';

export interface QuestionContentWriterEntry {
  status: QuestionContentWriterStatus;
  /** 收敛/跟踪 ticket。 */
  tickets: string[];
  note: string;
}

export const QUESTION_CONTENT_WRITER_REGISTRY: Record<string, QuestionContentWriterEntry> = {
  // ─── 已收敛（YUK-1043：同事务 publishQuestionGroup*） ───
  'src/server/questions/write.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'editQuestion：判分输入字段（题面/答案/选项/题型）变更 ⇒ 同事务统一发布；archiveQuestion ⇒ lifecycle withdrawn（claim 释放由 hash 置 NULL 承担）。',
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
    note: '三处内容写全部同事务发布：mistake_variant 接受 INSERT ⇒ 首版 admitted（manual+human，D9）；question_draft 接受 promote ⇒ admission 维度翻 admitted（manual+human）；acceptQuestionEditProposal 的 structured 编辑 ⇒ 新 revision（admission preserve，node id 身份保留 §3.1）。拒绝路径不发布（tombstone 语义不变）。',
  },
  'src/capabilities/ingestion/server/legacy-record-appliers.ts': {
    status: 'publisher-converged',
    tickets: ['YUK-1043'],
    note: 'legacy dreaming 接受 INSERT ⇒ 同事务首版 admitted（manual+human）—— 可达接受路径不再是无契约写口（§2 矩阵行 13）。',
  },

  // ─── 待收敛（工作副本直写；cutover 前必须逐行收敛） ───
  // 注：quiz_verify / source_verify / verify-and-promote 的 promote 分支虽非内容列
  // 写者（只写 draft_status/metadata），但作为 §2 矩阵的 admission 时刻已在
  // YUK-1043 同事务接 publisher（见各文件 YUK-1043 注释），无需内容列登记。
  'scripts/seed-synthetic.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵：seed 也生成完整 revision（synthetic 标识保留，不靠审计豁免漏迁）。',
  },
  'src/capabilities/agency/server/conjecture/probe-lifecycle.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 probe 行：container-only；revision 与容器 occurrence 同事务绑定（§3.3），不进公共题池。',
  },
  'src/capabilities/copilot/server/teaching/materialize-ask-check.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 teaching_check 行：container-only 不免迁；教学 turn 与 revision/issuance 原子绑定。',
  },
  'src/capabilities/ingestion/api/mistakes.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵手动错题行：原错误作答证据不能成为答案键；题目契约与初次学习事实分别保留。',
  },
  'src/capabilities/ingestion/server/auto-enroll.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 OCR/VLM 自动收录行：原始提取/学生作答/参考答案分离；创建 revision 与使用范围。',
  },
  'src/capabilities/ingestion/server/image-candidate-accept.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 image_candidate 行：保留 terminal-rate 锁/来源图证据；后续 verify 撤销资格不丢已提交答案。',
  },
  'src/capabilities/ingestion/server/import-completion.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵上传确认导入行：无法结构化时使用通用开放作答契约，不丢内容。',
  },
  'src/capabilities/practice/jobs/quiz_gen.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵批量 quiz_gen 行：parent 行直写待收敛（composite 子 part 已经 parts.ts 收敛）；artifact 引用稳定身份，实际 serve 绑定版本。',
  },
  'src/capabilities/practice/server/tools/question-author.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 author_question 行：draft 持久化待收敛（candidate 不冒充已发布题）。',
  },
  'src/capabilities/practice/server/tools/store-sourced-question.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 web/jyeoo 行：INSERT 已走 sourced-draft-insert（converged）；此条目覆盖其 structured/figures/multimodal 事后富集 UPDATE（改变判分输入 ⇒ 需新 revision）。',
  },
  'src/capabilities/practice/server/intervention-diagnostics.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 intervention diagnostic 行（扫描器闭包修正后发现：map 回调体内的内容列曾被窗口截断漏检）：immediate/delayed/transfer 及教学材料版本纳入冻结上下文；一次性 claim 与题目审核状态分离；container-only 语义随 YUK-1059 收敛。',
  },
  'src/server/ai/solution-generate.ts': {
    status: 'working-copy-pending',
    tickets: ['YUK-1059'],
    note: '§2 矩阵 reference/rubric 富集行：生成参考答案影响评分依据，必须新 revision + 来源标识（同 reference_answer_backfill 语义）。',
  },
};
