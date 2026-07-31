import { describe, expect, it } from 'vitest';
import { normalizeInterventionPackageModelOutput } from './intervention-author';

const CLAIM = '学习者把外层导数和内层导数相加。';
const TARGET_ERROR = '把外层导数与内层导数相加，而不是相乘。';

function probeSpec(prompt: string) {
  return {
    schema_version: 2,
    prompt_md: prompt,
    reference_md: '2x cos(x²)',
    expected_target_error_answer_md: 'cos(x²)+2x',
    elicits_target_error_reason_md: '区分相乘与相加。',
    context_kind: 'abstract',
    representation_kind: 'symbolic',
    response_mode: 'short_answer',
    gold_response_signature: { kind: 'text', response_md: '2x cos(x²)' },
    target_error_response_signature: { kind: 'text', response_md: 'cos(x²)+2x' },
  };
}

describe('normalizeInterventionPackageModelOutput', () => {
  it('freezes diagnostic identities and moves transfer context_change_md out of probe_spec', () => {
    const output = {
      schema_version: 1,
      material: { title_md: '链式法则', body_md: '外层导数乘以内层导数。' },
      diagnostics: {
        immediate: {
          kind: 'delayed',
          probe_spec: probeSpec('立即题'),
          tested_claim_md: '模型改写的 claim',
          target_error_rule_md: '模型改写的规则',
        },
        delayed: {
          kind: 'immediate',
          probe_spec: probeSpec('延迟题'),
          tested_claim_md: '模型改写的 claim',
          target_error_rule_md: '模型改写的规则',
        },
        transfer: {
          kind: 'transfer',
          probe_spec: {
            ...probeSpec('迁移题'),
            context_kind: 'applied',
            representation_kind: 'natural_language',
            context_change_md: '从纯符号函数换到热膨胀情境。',
          },
        },
      },
    };

    const normalized = normalizeInterventionPackageModelOutput(output, {
      testedClaimMd: CLAIM,
      targetErrorRuleMd: TARGET_ERROR,
    });

    expect(normalized.diagnostics.immediate).toMatchObject({
      kind: 'immediate',
      tested_claim_md: CLAIM,
      target_error_rule_md: TARGET_ERROR,
    });
    expect(normalized.diagnostics.delayed).toMatchObject({
      kind: 'delayed',
      tested_claim_md: CLAIM,
      target_error_rule_md: TARGET_ERROR,
    });
    expect(normalized.diagnostics.transfer).toMatchObject({
      kind: 'transfer',
      tested_claim_md: CLAIM,
      target_error_rule_md: TARGET_ERROR,
      context_change_md: '从纯符号函数换到热膨胀情境。',
    });
    expect(normalized.diagnostics.transfer.probe_spec).not.toHaveProperty('context_change_md');
  });
});
