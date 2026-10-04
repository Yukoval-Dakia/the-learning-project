import { describe, expect, it } from 'vitest';
import { tasks } from '@/capabilities/task-registry';
import { createLoomPiModels } from './pi-models';
import { nativePiModel, nativePiModels, piProviderId } from './pi-provider-catalog';
import { isKnownProvider, providerAuthSurface } from './providers';

describe('native provider registry contract', () => {
  it('metadata used by config validation equals the installed native catalogs', async () => {
    const models = await createLoomPiModels();
    expect(isKnownProvider('zhipu')).toBe(false);
    expect(models.getModel('zhipu', 'glm-5.2')).toBeUndefined();
    for (const { name, implemented } of providerAuthSurface()) {
      if (!implemented) continue;
      const native = models.getModels(piProviderId(name));
      expect(Object.keys(nativePiModels(name)).sort()).toEqual(native.map((m) => m.id).sort());
      for (const model of native) {
        expect(model.provider).toBe(piProviderId(name));
        expect(nativePiModel(name, model.id)).toEqual({
          api: model.api,
          baseUrl: model.baseUrl,
          input: model.input,
          reasoning: model.reasoning,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        });
      }
    }
    expect(nativePiModel('xiaomi', '__proto__')).toBeUndefined();
  });

  it('all chat task defaults exist in native catalogs and preserve image input', async () => {
    const models = await createLoomPiModels();
    for (const task of Object.values(tasks)) {
      if ('execution' in task && task.execution === 'typed') continue;
      const model = models.getModel(piProviderId(task.defaultProvider), task.defaultModel);
      expect(model, task.kind).toBeDefined();
      if (task.isMultimodal) expect(model?.input, task.kind).toContain('image');
    }
  });

  it('retains native compat while OAuth shares the real Anthropic preset', async () => {
    const models = await createLoomPiModels();
    expect(models.getModel('xiaomi', 'mimo-v2.5-pro')).toMatchObject({
      api: 'openai-completions',
      compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
    });
    expect(models.getModel('zai-coding-cn', 'glm-5.3-flash')).toMatchObject({
      api: 'openai-completions',
      compat: { thinkingFormat: 'zai', zaiToolStream: true },
    });
    expect(models.getModel(piProviderId('anthropic-sub'), 'claude-opus-4-8')).toMatchObject({
      provider: 'anthropic',
      compat: { supportsMidConvoSystemMessages: true, forceAdaptiveThinking: true },
    });
    expect(models.getModel('anthropic-sub', 'claude-opus-4-8')).toBeUndefined();
  });
});
