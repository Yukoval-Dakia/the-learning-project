import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PublishedQuestionRevision, deriveIssuanceBinding } from '@/core/schema/assessment';
import type { assessment_issuance, question_revision } from '@/db/schema';
import { loadFrozenStudyImages, projectFrozenStudyContext } from './study-context';

function fixture() {
  const revision = PublishedQuestionRevision.parse({
    revision_id: 'rev_study',
    group_id: 'group_study',
    revision_ordinal: 1,
    integrity_digest: 'sha256:frozen-study',
    published_at: '2026-10-05T00:00:00.000Z',
    supersedes_revision_id: null,
    structure: {
      group_id: 'group_study',
      materials: [
        {
          material_id: 'passage',
          kind: 'passage',
          asset: { asset_id: 'text', digest: 'sha256:text' },
          content_md:
            '在相同水量下，比较不同坡度的流速。\n' +
            '控制变量：每次使用同一坡面材料。\n'.repeat(20),
        },
        {
          material_id: 'figure',
          kind: 'figure',
          asset: { asset_id: 'frozen-figure', digest: 'sha256:figure' },
          caption: '坡面实验图',
          alt_text: '左右两组坡度不同，水量相同。',
        },
        {
          material_id: 'private',
          kind: 'passage',
          asset: { asset_id: 'rub_123456abcdef', digest: 'sha256:private' },
          content_md: 'PRIVATE RUBRIC SECRET',
        },
      ],
      parts: [
        {
          part_id: 'p1',
          prompt_md: '比较坡度与速度，完成选择、配对、排序和表格。',
          material_ids: ['passage', 'figure', 'private'],
        },
        { part_id: 'p2', prompt_md: 'UNISSUED PROMPT', material_ids: [] },
      ],
    },
    response_spec: {
      slots: [
        {
          slot_id: 'choice',
          part_id: 'p1',
          kind: 'multi_choice',
          min_select: 1,
          max_select: 2,
          options: [
            { option_id: 'a', label: 'A', text: '坡度越大流速越快' },
            { option_id: 'b', label: 'B', text: '水量变化是本次变量' },
          ],
        },
        {
          slot_id: 'matching',
          part_id: 'p1',
          kind: 'matching',
          left_items: [
            { item_id: 'x', label: '甲', text: '坡度' },
            { item_id: 'y', label: '乙', text: '水量' },
          ],
          right_options: [
            { option_id: 'a', label: 'Ⅰ', text: '自变量' },
            { option_id: 'b', label: 'Ⅱ', text: '控制量' },
          ],
        },
        {
          slot_id: 'ordering',
          part_id: 'p1',
          kind: 'ordering',
          items: [
            { item_id: 'x', label: '①', text: '设定坡度' },
            { item_id: 'y', label: '②', text: '测量流速' },
          ],
        },
        {
          slot_id: 'table',
          part_id: 'p1',
          kind: 'table',
          column_headers: ['速度'],
          row_labels: ['坡度10°'],
          cells: [{ row: 0, col: 0, slot_id: 'speed' }],
        },
        {
          slot_id: 'speed',
          part_id: 'p1',
          kind: 'numeric',
          unit_hint: 'm/s',
          precision: 2,
          placement: { row: 0, col: 0, label: '流速' },
        },
        {
          slot_id: 'unissued',
          part_id: 'p2',
          kind: 'single_choice',
          options: [
            { option_id: 'a', label: 'A', text: 'UNISSUED ANSWER' },
            { option_id: 'b', label: 'B', text: 'UNISSUED OPTION' },
          ],
        },
      ],
    },
    scoring_basis: {
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
      units: [
        {
          scoring_unit_id: 'u_choice',
          slot_refs: ['choice'],
          points: 1,
          criterion: { kind: 'option_set_key', accepted_option_ids: ['a'] },
        },
        {
          scoring_unit_id: 'u_matching',
          slot_refs: ['matching'],
          points: 2,
          criterion: {
            kind: 'matching_pairs_key',
            accepted_pairs: [
              { item_id: 'x', option_id: 'a' },
              { item_id: 'y', option_id: 'b' },
            ],
          },
        },
        {
          scoring_unit_id: 'u_ordering',
          slot_refs: ['ordering'],
          points: 1,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'order-rule',
            statement_md: '先设定坡度再测量流速。',
            source: 'official',
          },
        },
        {
          scoring_unit_id: 'u_speed',
          slot_refs: ['speed'],
          points: 1,
          criterion: {
            kind: 'numeric_key',
            expected: 0.8,
            expected_unit: 'm/s',
            tolerance: { kind: 'absolute', value: 0.01 },
          },
        },
        {
          scoring_unit_id: 'u_unissued',
          slot_refs: ['unissued'],
          points: 1,
          criterion: { kind: 'option_set_key', accepted_option_ids: ['a'] },
        },
      ],
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u_choice', 'u_matching', 'u_ordering', 'u_speed', 'u_unissued'],
          executor: { kind: 'human_review' },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'accept' },
    },
  });
  const row: typeof question_revision.$inferSelect = {
    ...revision,
    published_at: new Date(revision.published_at),
    availability: 'general_pool',
    published_by: null,
  };
  const issuance: typeof assessment_issuance.$inferSelect = {
    ...deriveIssuanceBinding(revision, {
      part_ids: ['p1'],
      option_order_overrides: { choice: ['b', 'a'], matching: ['b', 'a'] },
    }),
    issuance_id: 'issued_study',
    issued_at: new Date(revision.published_at),
    container_occurrence_ref: null,
    claim_policy: 'unbounded',
    claim_status: 'unclaimed',
    claimed_by_ref: null,
  };
  return { row, issuance };
}

describe('frozen study context', () => {
  it('retains the served native response shape and public material descriptions for teaching', () => {
    const { row, issuance } = fixture();
    const context = projectFrozenStudyContext(row, issuance);
    const face = context.practice_dto;
    expect(face.response_spec.slots.map((slot) => slot.slot_id)).toEqual([
      'choice',
      'matching',
      'ordering',
      'table',
      'speed',
    ]);
    expect(face.response_spec.slots[0]).toMatchObject({
      options: [
        { option_id: 'b', text: '水量变化是本次变量' },
        { option_id: 'a', text: '坡度越大流速越快' },
      ],
    });
    expect(face.response_spec.slots[1]).toMatchObject({
      left_items: [{ text: '坡度' }, { text: '水量' }],
      right_options: [{ text: '控制量' }, { text: '自变量' }],
    });
    expect(face.response_spec.slots[3]).toMatchObject({
      column_headers: ['速度'],
      row_labels: ['坡度10°'],
      cells: [{ slot_id: 'speed' }],
    });
    expect(face.materials).toContainEqual(
      expect.objectContaining({
        asset_id: 'frozen-figure',
        caption: '坡面实验图',
        alt_text: '左右两组坡度不同，水量相同。',
      }),
    );
    expect(JSON.stringify(face)).not.toMatch(
      /PRIVATE|UNISSUED|accepted_option_ids|accepted_pairs|order-rule/,
    );
  });

  it('resolves private references in the scoring unit slot scope, including matching identities', () => {
    const { row, issuance } = fixture();
    const { reference_md } = projectFrozenStudyContext(row, issuance);
    expect(reference_md).toContain('A. 坡度越大流速越快');
    expect(reference_md).toContain('甲. 坡度 → Ⅰ. 自变量');
    expect(reference_md).toContain('乙. 水量 → Ⅱ. 控制量');
    expect(reference_md).not.toContain('①. 设定坡度 →');
    expect(reference_md).not.toMatch(/PRIVATE|UNISSUED/);
  });
});

function mediaFixture() {
  const { row, issuance } = fixture();
  const context = projectFrozenStudyContext(row, issuance);
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  for (const material of context.public_materials) {
    material.asset.digest = `sha256:${createHash('sha256')
      .update(material.kind === 'figure' ? bytes : (material.content_md ?? ''))
      .digest('hex')}`;
  }
  const load = vi.fn(async () => ({ bytes, mime_type: 'image/png' }));
  return { context, bytes, load, signal: new AbortController().signal };
}

describe('frozen study image resolution', () => {
  it.each(['face', 'material', 'choice', 'matching', 'ordering', 'table', 'reference'])(
    'holds unbound inline images in %s before loading assets',
    async (location) => {
      const { context, load, signal } = mediaFixture();
      const text = '![图][original]\n\n[original]: /api/assets/private/content';
      const slots = context.practice_dto.response_spec.slots;
      if (location === 'face') context.practice_dto.faces[0].prompt_md = text;
      if (location === 'material') context.practice_dto.materials[0].content_md = text;
      if (location === 'reference') context.reference_md = text;
      for (const slot of slots) {
        if (location === 'choice' && slot.kind === 'multi_choice') slot.options[0].text = text;
        if (location === 'matching' && slot.kind === 'matching') slot.left_items[0].text = text;
        if (location === 'ordering' && slot.kind === 'ordering') slot.items[0].text = text;
        if (location === 'table' && slot.kind === 'table') slot.column_headers[0] = text;
      }
      await expect(loadFrozenStudyImages(context, load, signal)).rejects.toMatchObject({
        code: 'study_media_unavailable',
      });
      expect(load).not.toHaveBeenCalled();
    },
  );

  it.each([
    '![图](/api/assets/frozen-figure/content)',
    '![图][ref]\n\n[ref]: /api/assets/frozen-figure/content',
    '> ![图][]\n\n[图]: /api/assets/frozen-figure/content',
    '[![图](/api/assets/frozen-figure/content)](https://example.com)',
    '`![not an image](https://example.com)`',
    '\\![escaped](https://example.com)',
  ])(
    'resolves trusted rendered references and leaves code/escaped examples as text: %s',
    async (text) => {
      const { context, bytes, load, signal } = mediaFixture();
      context.practice_dto.faces[0].prompt_md = text;
      const result = await loadFrozenStudyImages(context, load, signal);
      expect(result.images).toEqual([
        { data: Buffer.from(bytes).toString('base64'), mediaType: 'image/png' },
      ]);
      expect(load).toHaveBeenCalledOnce();
      expect(load.mock.calls[0]).toEqual([context.public_materials[1].asset, signal]);
    },
  );

  it('refuses altered inline material bytes and cancellation before a model can run', async () => {
    const { context, load, signal } = mediaFixture();
    context.public_materials[0].content_md = 'changed';
    await expect(loadFrozenStudyImages(context, load, signal)).rejects.toMatchObject({
      code: 'study_media_unavailable',
    });
    expect(load).not.toHaveBeenCalled();
    const fresh = mediaFixture();
    await expect(
      loadFrozenStudyImages(fresh.context, fresh.load, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'study_media_unavailable' });
    expect(fresh.load).not.toHaveBeenCalled();
  });
});
