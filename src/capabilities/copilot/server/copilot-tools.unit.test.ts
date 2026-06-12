import { describe, expect, it } from 'vitest';

import { capabilities } from '@/capabilities';
import { COPILOT_TOOLS } from '@/server/ai/tools/allowlists';

// 裁决 h：COPILOT_TOOLS 数组保持字面量（src/ai 浏览器共享面不能 import
// @/capabilities）；归属真相源 = 各包 manifest.copilotTools，本测试强制两面相等。
describe('copilotTools 贡献制 ↔ COPILOT_TOOLS allowlist 对账', () => {
  it('五包声明聚合与运行时 allowlist 集合相等且无重复', () => {
    const declared = capabilities.flatMap((c) => c.copilotTools?.tools.map((t) => t.name) ?? []);
    expect(new Set(declared)).toEqual(new Set(COPILOT_TOOLS));
    expect(declared).toHaveLength(COPILOT_TOOLS.length);
  });
});
