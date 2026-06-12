import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityManifest } from '@/kernel/manifest';
import { registerCapabilityCopilotTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests, getTool, registerTool } from '@/server/ai/tools/registry';
import type { DomainTool } from '@/server/ai/tools/types';

const fakeTool = (name: string) =>
  ({ name, description: name, effect: 'read', execute: vi.fn() }) as unknown as DomainTool<
    unknown,
    unknown
  >;

const cap = (tools: CapabilityManifest['copilotTools']): CapabilityManifest => ({
  name: 'x',
  description: 'x',
  copilotTools: tools && { tools: tools.tools },
});

afterEach(() => __resetRegistryForTests());

describe('registerCapabilityCopilotTools', () => {
  it('懒加载 thunk 注册进 DomainTool registry', async () => {
    await registerCapabilityCopilotTools([
      cap({ tools: [{ name: 't1', load: async () => fakeTool('t1') }] }),
    ]);
    expect(getTool('t1')).toBeDefined();
  });

  it('已注册（CORE_TOOLS 幂等兜底先到）→ 跳过，不触发 duplicate throw', async () => {
    registerTool(fakeTool('t1'));
    await expect(
      registerCapabilityCopilotTools([
        cap({ tools: [{ name: 't1', load: async () => fakeTool('t1') }] }),
      ]),
    ).resolves.toBeUndefined();
  });

  it('manifest 声明名与模块导出名不一致 → throw', async () => {
    await expect(
      registerCapabilityCopilotTools([
        cap({ tools: [{ name: 't1', load: async () => fakeTool('OTHER') }] }),
      ]),
    ).rejects.toThrow(/t1.*OTHER/);
  });

  it('无 load 的 decl 是纯归属元数据，不被挂载', async () => {
    await registerCapabilityCopilotTools([cap({ tools: [{ name: 't1' }] })]);
    expect(getTool('t1')).toBeUndefined();
  });
});
