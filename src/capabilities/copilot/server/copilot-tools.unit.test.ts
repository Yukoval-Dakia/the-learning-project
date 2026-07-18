import { describe, expect, it } from 'vitest';

import { capabilities } from '@/capabilities';
import { COPILOT_TOOLS, PROPOSE_WRITE_TOOLS, READ_TOOLS } from '@/server/ai/tools/allowlists';

// 裁决 h：COPILOT_TOOLS 数组保持字面量（src/ai 浏览器共享面不能 import
// @/capabilities）；归属真相源 = 各包 manifest.copilotTools，本测试强制两面相等。
describe('copilotTools 贡献制 ↔ COPILOT_TOOLS allowlist 对账', () => {
  it('五包声明聚合覆盖完整 DomainTool inventory 且无重复', () => {
    const declared = capabilities.flatMap((c) => c.copilotTools?.tools.map((t) => t.name) ?? []);
    const fullInventory = [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS];
    expect(new Set(declared)).toEqual(new Set(fullInventory));
    expect(declared).toHaveLength(fullInventory.length);
  });

  it('浏览器共享的 Copilot 字面 allowlist 是 manifest 完整 inventory 的精确子集', () => {
    const declared = new Set(
      capabilities.flatMap((c) => c.copilotTools?.tools.map((t) => t.name) ?? []),
    );
    expect(COPILOT_TOOLS.every((name) => declared.has(name))).toBe(true);
    expect(new Set(COPILOT_TOOLS).size).toBe(COPILOT_TOOLS.length);
  });
});
