import { defineCapability } from '@/kernel/manifest';

// M3-T1 (YUK-317)：notes 包骨架。routes 在 T4（API 上 Hono）逐条填充——
// 9 条：notes/[id] GET + artifacts/[id]/{body-blocks,sections/[sectionId],
// backlinks,correct,ai-changes,ai-changes/[eventId]/undo} + artifacts/search
// + hubs/[id]/dismiss-link。
export const notesCapability = defineCapability({
  name: 'notes',
  description:
    '笔记域：artifact 笔记的读（note-page 聚合 / notes-read 按知识点）、写（body-blocks 块编辑 ' +
    '乐观锁 / sections / block-refs 反链索引）与 Living Note refine 链（triggers→policy→' +
    'mutator|propose，D6 后信号源 = mark_wrong/mastery_change/dwell/dreaming）。',
  api: {
    routes: [],
  },
});
