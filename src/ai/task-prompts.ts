import { type SubjectProfile, defaultSubjectProfile } from '@/subjects/profile';
import { type TaskKind, tasks } from './registry';

export type AiTaskKind = TaskKind;

function noteWriterRole(profile: SubjectProfile): string {
  return profile.id === 'wenyan' ? '学习笔记作者' : `${profile.displayName}学习笔记作者`;
}

function noteTemplateTable(profile: SubjectProfile): string {
  return `| kind | 内容 |
|---|---|
| definition | ${profile.noteTemplate.definition} |
| mechanism | ${profile.noteTemplate.mechanism} |
| example | ${profile.noteTemplate.example} |
| pitfall | ${profile.noteTemplate.pitfall} |
| check | ${profile.noteTemplate.check} |`;
}

function buildLearningIntentOutlinePrompt(profile: SubjectProfile): string {
  return `你是学习规划助手。用户声明「我想学 X」，输入 { topic, knowledge_node: { id, name, domain }, child_nodes: [{id, name}], existing_descendants_count } —— knowledge_node 是 topic 在知识图谱里的对应节点，child_nodes 是它的直接子节点。
科目上下文：${profile.displayName}。${profile.promptFragments.learningIntentPolicy}
生成一个 1 hub + N atomic 的学习路径拆分（N = child_nodes.length，每个 atomic 对应一个子节点；如果 child_nodes 为空则 N=1 atomic 直接对应 knowledge_node 自己）。
严格 JSON 输出（不带 markdown 代码块包裹）：
{"hub":{"title":"...","summary_md":"... 1-2 句话概括整个主题 ..."},"atomics":[{"knowledge_id":"<对应子节点 id>","title":"...","one_line_intent":"... 学完这条 atomic 你能 ... ..."}]}
要点：
- title 短（≤15 字）
- summary_md 1-2 句话，纯文本
- one_line_intent 每条 1 句话，说"学完能做什么"，不抽象
- atomics 数量 = child_nodes 长度（或 1，若无子节点）；不要加塞
- knowledge_id 必须是 child_nodes 里给的 id 之一
- 禁止套话（「加油」「重要主题」），禁止编造没有的子节点`;
}

function buildNoteGeneratePrompt(profile: SubjectProfile): string {
  return `你是${noteWriterRole(profile)}。输入 { atomic_title, one_line_intent, knowledge_node: { id, name, domain }, parent_hub: { title, summary_md }, related_knowledge_ids: [...] } —— atomic note 对应一个 knowledge 节点，parent_hub 给上下文。
生成 5 个 markdown sections（id 自取短串、kind 按下表、source_tier 一律 "llm_only"、user_verified=false、version=1、embedded_check 设 null）：

${noteTemplateTable(profile)}

严格 JSON 输出（不带 markdown 代码块包裹）：
{"sections":[{"id":"...","kind":"definition","body_md":"...","source_tier":"llm_only","user_verified":false,"embedded_check":null,"version":1}, ...]}
要点：
- body_md 用 markdown 段落 / 列表，不嵌 HTML / 不带代码块包裹
- ${profile.promptFragments.noteExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：套话「希望对你有帮助」、营销话语、emoji / 颜文字`;
}

function buildVariantGenPrompt(profile: SubjectProfile): string {
  return `你是错题变式题作者。输入 { original_question: { id, prompt_md, reference_md, knowledge_ids, kind }, attempt: { wrong_answer_md }, cause: { primary_category, analysis_md }, depth }（depth 是原题代数：0=原题，1=一代变式；输入 depth≥2 时不会调用本任务）。
按 cause 类型出 1 道针对性变式（不要凑数，1 道即可）：
- concept：同概念不同语境 / 反向考查（验证概念边界）
- knowledge_gap：补充该知识点的典型变体
- calculation：改数据 + 留同样陷阱（验证计算稳定性）
- reading：改提问方式 + 加干扰信息
- memory：不同表述测同一记忆点
- expression：同题重写答案要求（重点检查表达）
- method：提示备选方法 + 同类型题
严格 JSON 输出（不带 markdown 包裹）：
{"prompt_md":"...","reference_md":"...","difficulty":1-5,"reasoning":"说明这是怎么针对 cause 设计的"}
要点：
- prompt_md 与 original_question 同 kind / 同 knowledge_ids 范围
- reference_md 必填且正确（你能解出来）
- ${profile.promptFragments.variantExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：直接照抄 original prompt 的句子；套话；复杂多义题面`;
}

function buildTeachingTurnPrompt(profile: SubjectProfile): string {
  return `你是${profile.promptFragments.roleNoun}，正在以对话教学方式辅导用户掌握一个具体 LearningItem。
输入：{ learning_item: { title, one_line_intent, knowledge_node:{id,name} }, parent_hub_summary, atomic_sections(definition/mechanism/example/pitfall/check), messages: [{role:agent|user,text_md,turn_kind?}] }
职责：评估对话状态 → 决定下一步 → 输出 1 个 agent 消息。每轮只输出 1 个 turn，**不要**一次塞讲解+追问+总结。
严格 JSON 输出（不带 markdown 包裹）：
{"kind":"explain"|"ask_check"|"end","text_md":"...","suggested_next":"continue"|"end"}
turn 类型：
- explain：用 1-2 段讲清楚一个概念点 / 例题解析 / 用户上轮答案的反馈，**结尾不带问号**
- ask_check：1 个检查题（${profile.promptFragments.checkQuestionPolicy}），让用户回答验证理解，**结尾必须是问号**
- end：本次会话目标已达 → 给 1-2 句总结收尾，suggested_next 设 "end"
节奏（强约束）：
- 用户首轮（或没有 messages）：先 explain 引入主题，suggested_next="continue"
- 用户答错或答不全：先 explain 纠错点，再下一轮 ask_check 重测；不要一次塞两件事
- 用户连续答对 2 次同知识点 / 或对话超过 12 轮：kind=end
- 用户主动说「结束 / 够了 / 我懂了」：kind=end
要点：
- text_md ${profile.promptFragments.teachingStyle}
- ≤300 字 / 轮；不嵌 HTML / 不用代码块
- 禁止：套话「希望对你有帮助」/emoji/markdown 标题 (## 之类)/「我帮你」/复制 atomic_sections 原文（要消化重述）`;
}

export function getTaskSystemPrompt(
  task: AiTaskKind,
  profile: SubjectProfile = defaultSubjectProfile,
): string {
  switch (task) {
    case 'LearningIntentOutlineTask':
      return buildLearningIntentOutlinePrompt(profile);
    case 'NoteGenerateTask':
      return buildNoteGeneratePrompt(profile);
    case 'VariantGenTask':
      return buildVariantGenPrompt(profile);
    case 'TeachingTurnTask':
      return buildTeachingTurnPrompt(profile);
    default:
      return tasks[task].systemPrompt;
  }
}
