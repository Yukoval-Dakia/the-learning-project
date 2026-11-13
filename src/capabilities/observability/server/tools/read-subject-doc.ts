// read_subject_doc — 科目经验文档库的共享只读工具。
//
// 三种用法：不给参数回目录（doc_key + 标题 + 用途），给 doc_key 回一篇正文，
// 给 search 跨标题/用途/正文搜索并回命中片段。subject_id 传本科目 id；general
// 文档是所有科目的共享层，本科目同键文档优先。读权限按设计默认放开，授权面
// 在 kernel/tools/allowlists.ts。

import { z } from 'zod';
import {
  listSubjectDocCatalog,
  readSubjectDoc,
  searchSubjectDocs,
} from '@/kernel/read-models/subject-docs';
import type { DomainTool } from '@/kernel/tools/types';
import { resolveKnownSubjectId } from '@/subjects/profile';

const InputSchema = z.object({
  subject_id: z
    .string()
    .min(1)
    .describe('本科目 id 或别名（math / yuwen / physics / general 或自定义科目 id）'),
  doc_key: z
    .string()
    .min(1)
    .optional()
    .describe('目录里的文档键（如 skill/note、guide/teaching）；给了就读该篇正文'),
  search: z.string().min(1).optional().describe('关键词；给了就跨文档搜索并回命中键与片段'),
});

const DocEntrySchema = z.object({
  subject_id: z.string(),
  doc_key: z.string(),
  title: z.string(),
  summary: z.string(),
  /** true = 来自 general 共享层而非本科目。 */
  shared: z.boolean(),
  /** search 命中时的上下文片段；目录/点查时为 null。 */
  excerpt: z.string().nullable(),
});

const DocBodySchema = DocEntrySchema.omit({ excerpt: true }).extend({
  body: z.string(),
  revision: z.number(),
});

const OutputSchema = z.object({
  /** 解析后的科目 id。 */
  subject_id: z.string(),
  /** 目录或搜索命中列表；点查 doc_key 时带回目录便于发现相关篇目。 */
  docs: z.array(DocEntrySchema),
  /** doc_key 命中的正文；未命中或本次未点查为 null。 */
  doc: DocBodySchema.nullable(),
  /** 需要调用方注意时的一句说明（如 key 不存在）；正常为 null。 */
  note: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

async function execute(ctx: Parameters<DomainTool<Input, Output>['execute']>[0], input: Input) {
  const subjectId = resolveKnownSubjectId(input.subject_id) ?? input.subject_id.trim();

  if (input.doc_key) {
    const doc = await readSubjectDoc(ctx.db, subjectId, input.doc_key);
    const catalog = await listSubjectDocCatalog(ctx.db, subjectId);
    return {
      subject_id: subjectId,
      docs: [
        ...catalog.own.map((d) => ({ ...d, shared: false, excerpt: null })),
        ...catalog.shared.map((d) => ({ ...d, shared: true, excerpt: null })),
      ],
      doc: doc ? { ...doc, shared: doc.subject_id !== subjectId } : null,
      note: doc ? null : `doc_key「${input.doc_key}」不存在，可用键见 docs`,
    };
  }

  if (input.search) {
    const hits = await searchSubjectDocs(ctx.db, subjectId, input.search);
    return {
      subject_id: subjectId,
      docs: hits.map((h) => ({
        subject_id: h.subject_id,
        doc_key: h.doc_key,
        title: h.title,
        summary: h.summary,
        shared: h.shared,
        excerpt: h.excerpt,
      })),
      doc: null,
      note: hits.length === 0 ? `没有文档命中「${input.search}」` : null,
    };
  }

  const catalog = await listSubjectDocCatalog(ctx.db, subjectId);
  return {
    subject_id: subjectId,
    docs: [
      ...catalog.own.map((d) => ({ ...d, shared: false, excerpt: null })),
      ...catalog.shared.map((d) => ({ ...d, shared: true, excerpt: null })),
    ],
    doc: null,
    note:
      catalog.own.length === 0 && catalog.shared.length === 0
        ? `科目「${subjectId}」还没有经验文档`
        : null,
  };
}

export const readSubjectDocTool: DomainTool<Input, Output> = {
  name: 'read_subject_doc',
  description:
    '读本科目经验文档库：不给参数回目录（doc_key + 标题 + 用途），给 doc_key 读该篇正文，给 search 跨文档搜索命中片段。科目怎么教、笔记/出题/变式政策、题型规范与精选范例都在这里——系统提示只带目录，正文需要时在这里读，不要凭记忆写。general 的文档对所有科目开放。',
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize(input, output) {
    if (input.doc_key) {
      return `subject doc · ${output.subject_id}/${input.doc_key} · ${output.doc ? `${output.doc.body.length} chars` : 'miss'}`;
    }
    return `subject docs · ${output.subject_id} · ${output.docs.length} entries`;
  },
  mirrorEvent: 'when_user_visible',
};
