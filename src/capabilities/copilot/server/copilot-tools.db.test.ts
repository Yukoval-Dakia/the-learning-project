import { describe, expect, it } from 'vitest';

import { capabilities } from '@/capabilities';

describe('copilotTools load thunks', () => {
  it('所有贡献的 DomainTool 可加载且导出名与声明名一致', async () => {
    const decls = capabilities.flatMap((c) => c.copilotTools?.tools ?? []);
    expect(decls.length).toBeGreaterThan(0);
    expect(new Set(decls.map((decl) => decl.name)).size).toBe(decls.length);
    for (const decl of decls) {
      const tool = await decl.load?.();
      expect(tool?.name, `decl '${decl.name}' 的模块导出名不匹配`).toBe(decl.name);
    }
  });
});
