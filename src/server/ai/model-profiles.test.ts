// YUK-924 — ModelProfile registry unit: config-over-catalog resolution, the
// four active models' complete profiles, fail-closed narrow parse, the
// model-only legacy lookup, and the P2 capability gate.
//
// Pure no-DB unit: imports only ./model-profiles + ./providers (which imports
// @/ai/registry). No @/db / pg / drizzle / SDK runtime surface, so this lives
// in the fast (unit) partition. It MUST be enumerated in fastTestInclude
// (vitest.shared.ts): src/server/ai/** has no unit glob.

import { describe, expect, it } from 'vitest';
import {
  type CapabilityGatedTaskDef,
  assertModelProfileCapabilityFit,
  parseCatalogModelEntry,
  resolveModelProfile,
  resolveModelProfileByModel,
} from './model-profiles';

const noRequirements = (kind: string): CapabilityGatedTaskDef => ({
  kind,
  needsToolCall: false,
  isMultimodal: false,
});

describe('resolveModelProfile — precedence', () => {
  it('all-miss resolves to conservative tri-state defaults', () => {
    const profile = resolveModelProfile('anthropic', 'not-a-real-model');
    expect(profile.source).toBe('binding'); // anthropic modelDefaults (meteredUsd) applied
    expect(profile.capabilities).toEqual({
      toolCalling: 'unknown',
      vision: 'unknown',
      reasoning: 'unknown',
      structuredOutput: 'unknown',
    });
    expect(profile.limits).toEqual({});
    expect(profile.execution).toEqual({
      timeoutClass: 'standard',
      budgetClass: 'heavy', // anthropic modelDefaults
      meteredUsd: true, // anthropic modelDefaults
      localPricebook: false,
    });
  });

  it('unmapped provider resolves to pure conservative defaults', () => {
    const profile = resolveModelProfile('openrouter', 'anything-gpt');
    expect(profile.source).toBe('defaults');
    expect(profile.capabilities.toolCalling).toBe('unknown');
    expect(profile.execution.meteredUsd).toBe(false);
  });

  it('binding field wins over catalog (mimo-v2.5-pro vision override)', () => {
    // models.dev lists mimo-v2.5-pro as text-only; our operational binding
    // declares vision true (production multimodal judges run on this lane).
    const profile = resolveModelProfile('xiaomi', 'mimo-v2.5-pro');
    expect(profile.capabilities.vision).toBe(true);
    expect(profile.source).toBe('binding');
    // Catalog fields the binding does not override still fall through.
    expect(profile.limits.contextWindowTokens).toBe(1_048_576);
    expect(profile.limits.maxOutputTokens).toBe(131_072);
    expect(profile.capabilities.toolCalling).toBe(true);
  });

  it('catalog knowledge falls through when the binding is silent', () => {
    // glm-5.2 has a per-model binding (budgetClass), so the catalog layer must
    // still contribute the fields the binding omits.
    const profile = resolveModelProfile('zhipu', 'glm-5.2');
    expect(profile.capabilities.structuredOutput).toBe(true);
    expect(profile.capabilities.toolCalling).toBe(true);
    expect(profile.capabilities.vision).toBe(false); // catalog: text-only
    expect(profile.limits).toEqual({ contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 });
    expect(profile.reasoning).toEqual({
      mode: 'effort',
      supportedEfforts: ['high', 'max'],
      defaultEffort: 'high', // binding operational default
    });
    expect(profile.execution.timeoutClass).toBe('standard');
  });

  it('provider-wide modelDefaults apply to catalog-miss model ids too', () => {
    // Byte-parity backbone for runner site 2: EVERY xiaomi model id (including
    // ids the catalog does not know) gets structuredOutput disabled.
    const unknownXiaomi = resolveModelProfile('xiaomi', 'mimo-v3-future');
    expect(unknownXiaomi.capabilities.structuredOutput).toBe(false);
    expect(unknownXiaomi.capabilities.toolCalling).toBe('unknown');
  });
});

describe('resolveModelProfile — the four active models (acceptance)', () => {
  it('xiaomi/mimo-v2.5-pro: complete profile', () => {
    const profile = resolveModelProfile('xiaomi', 'mimo-v2.5-pro');
    expect(profile.capabilities).toEqual({
      toolCalling: true,
      vision: true, // binding override over stale catalog
      reasoning: true,
      structuredOutput: false, // binding modelDefaults (site 2)
    });
    expect(profile.limits).toEqual({ contextWindowTokens: 1_048_576, maxOutputTokens: 131_072 });
    expect(profile.reasoning).toEqual({ mode: 'toggle', supportedEfforts: [] });
    expect(profile.execution).toEqual({
      timeoutClass: 'standard',
      budgetClass: 'standard',
      meteredUsd: false,
      localPricebook: true, // site 5
    });
  });

  it('xiaomi/mimo-v2.5: complete profile (vision straight from catalog)', () => {
    const profile = resolveModelProfile('xiaomi', 'mimo-v2.5');
    expect(profile.capabilities.vision).toBe(true);
    expect(profile.capabilities.structuredOutput).toBe(false);
    expect(profile.execution.localPricebook).toBe(true);
  });

  it('zhipu/glm-5.2 (coding plan): complete profile', () => {
    const profile = resolveModelProfile('zhipu', 'glm-5.2');
    expect(profile.capabilities.structuredOutput).toBe(true);
    expect(profile.capabilities.vision).toBe(false);
    expect(profile.execution).toEqual({
      timeoutClass: 'standard',
      budgetClass: 'heavy',
      meteredUsd: false,
      localPricebook: false,
    });
  });

  it('zhipu/glm-5.3-flash: durable-heavy tier from the binding (site 1)', () => {
    const profile = resolveModelProfile('zhipu', 'glm-5.3-flash');
    expect(profile.execution.timeoutClass).toBe('durable-heavy');
    expect(profile.execution.budgetClass).toBe('cheap');
    expect(profile.capabilities.vision).toBe(true); // catalog: image input
    expect(profile.capabilities.toolCalling).toBe(true);
    expect(profile.limits).toEqual({ contextWindowTokens: 1_000_000, maxOutputTokens: 131_072 });
  });

  it('anthropic claude series: metered on anthropic, unmetered on anthropic-sub (site 3)', () => {
    const direct = resolveModelProfile('anthropic', 'claude-opus-4-8');
    expect(direct.execution.meteredUsd).toBe(true);
    expect(direct.capabilities.vision).toBe(true);
    expect(direct.capabilities.structuredOutput).toBe(true);
    expect(direct.limits).toEqual({ contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 });
    expect(direct.reasoning).toEqual({
      mode: 'effort',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: undefined,
    });

    const sub = resolveModelProfile('anthropic-sub', 'claude-opus-4-8');
    expect(sub.execution.meteredUsd).toBe(false);
    // Same model ids → same catalog capability/limits knowledge.
    expect(sub.capabilities).toEqual(direct.capabilities);
    expect(sub.limits).toEqual(direct.limits);
  });
});

describe('parseCatalogModelEntry — narrow fail-closed parse', () => {
  it('parses only the consumed fields and ignores the rest', () => {
    const parsed = parseCatalogModelEntry({
      id: 'x',
      description: 'ignored',
      family: 'ignored',
      tool_call: true,
      structured_output: false,
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'bogus', 'max', 7] }],
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1000, output: 512 },
      cost: { input: 3, output: 15 },
      temperature: true,
    });
    expect(parsed).toEqual({
      toolCalling: true,
      structuredOutput: false,
      reasoning: true,
      vision: true,
      contextWindowTokens: 1000,
      maxOutputTokens: 512,
      reasoningMode: 'effort',
      supportedEfforts: ['low', 'max'],
    });
  });

  it('budget_tokens and toggle reasoning options carry no effort ladder', () => {
    expect(
      parseCatalogModelEntry({ reasoning_options: [{ type: 'budget_tokens', min: 1024 }] }),
    ).toEqual({ reasoningMode: 'budget_tokens' });
    expect(parseCatalogModelEntry({ reasoning_options: [{ type: 'toggle' }] })).toEqual({
      reasoningMode: 'toggle',
    });
  });

  it('drops malformed fields instead of guessing (fail-closed)', () => {
    expect(parseCatalogModelEntry(null)).toEqual({});
    expect(parseCatalogModelEntry('nope')).toEqual({});
    expect(
      parseCatalogModelEntry({ tool_call: 'yes', limit: { context: -1, output: 1.5 } }),
    ).toEqual({});
    expect(
      parseCatalogModelEntry({
        modalities: { input: 'text' },
        reasoning_options: [{ type: 'weird' }],
      }),
    ).toEqual({});
  });
});

describe('resolveModelProfileByModel — legacy model-only lookup', () => {
  it('finds the provider that actually knows the model id', () => {
    expect(resolveModelProfileByModel('glm-5.3-flash').execution.timeoutClass).toBe(
      'durable-heavy',
    );
    expect(resolveModelProfileByModel('glm-5.3-flash').provider).toBe('zhipu');
    expect(resolveModelProfileByModel('mimo-v2.5-pro').execution.localPricebook).toBe(true);
    expect(resolveModelProfileByModel('claude-opus-4-8').execution.meteredUsd).toBe(true);
  });

  it('unknown ids degrade to the conservative defaults', () => {
    const profile = resolveModelProfileByModel('totally-unknown');
    expect(profile.execution.timeoutClass).toBe('standard');
    expect(profile.capabilities.vision).toBe('unknown');
  });
});

describe('assertModelProfileCapabilityFit — P2 fail-closed gate', () => {
  const toolTask: CapabilityGatedTaskDef = {
    kind: 'CopilotTask',
    needsToolCall: true,
    isMultimodal: false,
  };
  const multimodalTask: CapabilityGatedTaskDef = {
    kind: 'MultimodalDirectJudgeTask',
    needsToolCall: false,
    isMultimodal: true,
  };

  it('rejects a needsToolCall task on an unknown-tools lane', () => {
    // xiaomi modelDefaults apply to unknown ids too, so the profile source is
    // 'binding' — but toolCalling stayed 'unknown' and that is what rejects.
    expect(() => assertModelProfileCapabilityFit(toolTask, 'xiaomi', 'mystery-model')).toThrow(
      /CopilotTask requires tool calling.*mystery-model.*has no confirmed/i,
    );
    expect(() => assertModelProfileCapabilityFit(toolTask, 'openrouter', 'mystery-model')).toThrow(
      /profile source: defaults/,
    );
  });

  it('rejects a needsToolCall task on a confirmed no-tools lane', () => {
    // Synthetic no-tools lane: catalog models all support tools today, so use
    // the same unknown-model path the runTask gate takes, plus a vision case
    // with a REAL confirmed-false catalog entry below.
    expect(() => assertModelProfileCapabilityFit(toolTask, 'openrouter', 'whatever')).toThrow(
      /requires tool calling/,
    );
  });

  it('passes a needsToolCall task on a confirmed-tools lane', () => {
    expect(() =>
      assertModelProfileCapabilityFit(toolTask, 'xiaomi', 'mimo-v2.5-pro'),
    ).not.toThrow();
    expect(() => assertModelProfileCapabilityFit(toolTask, 'zhipu', 'glm-5.3-flash')).not.toThrow();
  });

  it('rejects a multimodal task on a confirmed text-only lane (glm-5.2)', () => {
    expect(() => assertModelProfileCapabilityFit(multimodalTask, 'zhipu', 'glm-5.2')).toThrow(
      /requires vision input.*glm-5.2.*does not support/i,
    );
  });

  it('passes a multimodal task where an explicit binding overrides a text-only catalog entry', () => {
    // mimo-v2.5-pro is text-only in the catalog; the xiaomi binding's explicit
    // vision declaration is what makes every production multimodal task pass.
    expect(() =>
      assertModelProfileCapabilityFit(multimodalTask, 'xiaomi', 'mimo-v2.5-pro'),
    ).not.toThrow();
  });

  it('rejects a multimodal task on an unknown-vision lane', () => {
    expect(() => assertModelProfileCapabilityFit(multimodalTask, 'anthropic', 'claude-x')).toThrow(
      /requires vision input.*no confirmed/i,
    );
  });

  it('tasks that need neither capability always pass', () => {
    expect(() =>
      assertModelProfileCapabilityFit(noRequirements('Anything'), 'openrouter', 'mystery'),
    ).not.toThrow();
  });
});
