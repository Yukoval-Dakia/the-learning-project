import { describe, expect, it } from 'vitest';

import { capabilities } from '@/capabilities';

describe('copilotTools load thunks', () => {
  // ADR-0032 D6-B (YUK-203 lane L6) — practice gained propose_question_edit (25→26).
  it('26 条 decl 全部可 resolve 且模块导出名与声明名一致', async () => {
    const decls = capabilities.flatMap((c) => c.copilotTools?.tools ?? []);
    expect(decls.length).toBe(26);
    for (const decl of decls) {
      const tool = await decl.load?.();
      expect(tool?.name, `decl '${decl.name}' 的模块导出名不匹配`).toBe(decl.name);
    }
  });
});
