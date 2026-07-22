import { describe, expect, it } from 'vitest';

import { capabilities } from '@/capabilities';

describe('copilotTools load thunks', () => {
  it('38 条完整 DomainTool decl 全部可 resolve 且模块导出名与声明名一致', async () => {
    const decls = capabilities.flatMap((c) => c.copilotTools?.tools ?? []);
    expect(decls.length).toBe(38);
    for (const decl of decls) {
      const tool = await decl.load?.();
      expect(tool?.name, `decl '${decl.name}' 的模块导出名不匹配`).toBe(decl.name);
    }
  });
});
