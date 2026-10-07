// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupEvidenceT } from '@/core/schema/assessment';
import { placementQuestionFixture, placementStartFixture } from './placement-fixtures';
import ScreenPlacement from './ScreenPlacement';

const mocks = vi.hoisted(() => ({
  startPlacement: vi.fn(),
  getPlacementSession: vi.fn(),
  placementNext: vi.fn(),
  placementEnd: vi.fn(),
  submitProbeAnswer: vi.fn(),
  saveResponseDraft: vi.fn(),
  uploadAsset: vi.fn(),
}));
vi.mock('./placement-api', () => mocks);
vi.mock('@/capabilities/practice/ui/practice-api', async (actual) => ({
  ...(await actual<typeof import('@/capabilities/practice/ui/practice-api')>()),
  saveResponseDraft: mocks.saveResponseDraft,
}));
vi.mock('@/ui/lib/assets', async (actual) => ({
  ...(await actual<typeof import('@/ui/lib/assets')>()),
  uploadAsset: mocks.uploadAsset,
}));

const photo: GroupEvidenceT['evidence'] = {
  evidence_id: 'handwritten_derivation',
  kind: 'image',
  asset: { asset_id: 'photo_derivation', digest: `sha256:${'a'.repeat(64)}` },
  mime_type: 'image/png',
  bytes: 4096,
  uploaded_at: '2026-10-05T00:00:00.000Z',
};

const coverageCases: {
  label: string;
  targets: GroupEvidenceT['target'][];
  requirementKind: 'model' | 'deterministic' | 'mixed' | 'missing';
  covered: boolean;
}[] = [
  {
    label: 'whole-page model evidence',
    targets: [{ scope: 'all_units' }],
    requirementKind: 'model',
    covered: true,
  },
  {
    label: 'all explicitly targeted model units',
    targets: [{ scope: 'units', scoring_unit_ids: ['unit_limit', 'unit_reasoning', 'unit_value'] }],
    requirementKind: 'model',
    covered: true,
  },
  {
    label: 'model units covered across two photos',
    targets: [
      { scope: 'units', scoring_unit_ids: ['unit_limit'] },
      { scope: 'units', scoring_unit_ids: ['unit_reasoning', 'unit_value'] },
    ],
    requirementKind: 'model',
    covered: true,
  },
  {
    label: 'one required unit missing within an otherwise covered slot',
    targets: [{ scope: 'units', scoring_unit_ids: ['unit_limit', 'unit_value'] }],
    requirementKind: 'model',
    covered: false,
  },
  {
    label: 'evidence for unrelated units',
    targets: [{ scope: 'units', scoring_unit_ids: ['unit_unrelated'] }],
    requirementKind: 'model',
    covered: false,
  },
  {
    label: 'whole-page photo without declared requirements',
    targets: [{ scope: 'all_units' }],
    requirementKind: 'missing',
    covered: false,
  },
  {
    label: 'whole-page photo for deterministic slots',
    targets: [{ scope: 'all_units' }],
    requirementKind: 'deterministic',
    covered: false,
  },
  {
    label: 'whole-page photo with one deterministic slot',
    targets: [{ scope: 'all_units' }],
    requirementKind: 'mixed',
    covered: false,
  },
];

function modelQuestion() {
  const question = multiSlotQuestion();
  const dto = question.assessment.state.practice_dto;
  if (!dto) throw new Error('Placement fixture must include its frozen question.');
  dto.response_requirements = [
    { slot_id: 'derivation', evidence_unit_ids: ['unit_limit', 'unit_reasoning'] },
    { slot_id: 'derivative', evidence_unit_ids: ['unit_value'] },
  ];
  return question;
}

function multiSlotQuestion() {
  const question = placementQuestionFixture();
  const dto = question.assessment.state.practice_dto;
  if (!dto) throw new Error('Placement fixture must include its frozen question.');
  dto.faces[0].prompt_md = '写出差商极限的推导，并给出 x² 在 x = 3 处的导数。';
  dto.response_spec.slots = [
    {
      kind: 'text',
      part_id: 'q1',
      slot_id: 'derivation',
      placement: { label: '推导过程' },
      math_preview: false,
    },
    {
      kind: 'numeric',
      part_id: 'q1',
      slot_id: 'derivative',
      placement: { label: '导数数值' },
    },
  ];
  dto.response_requirements = [
    { slot_id: 'derivation', evidence_unit_ids: [] },
    { slot_id: 'derivative', evidence_unit_ids: [] },
  ];
  return question;
}

function renderPlacement(question = multiSlotQuestion()) {
  mocks.startPlacement.mockResolvedValue(placementStartFixture(question));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScreenPlacement navigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/placement?goal=goal_1');
  mocks.saveResponseDraft.mockResolvedValue({ save_epoch: 1 });
  mocks.placementEnd.mockResolvedValue({ ok: true });
  mocks.submitProbeAnswer.mockResolvedValue({ status: 'effective' });
  mocks.placementNext.mockResolvedValue({ done: true, answeredCount: 1, reason: 'cap' });
  mocks.uploadAsset.mockResolvedValue({
    id: 'photo_derivation',
    storage_key: 'placement/derivation.png',
    mime_type: 'image/png',
    sha256: 'a'.repeat(64),
    byte_size: 4096,
    created_at: photo.uploaded_at,
  });
});
afterEach(cleanup);

describe('ScreenPlacement issued response coverage (YUK-1047)', () => {
  it.each([false, true])(
    'blocks a missing deterministic slot with photo=%s and submits all completed slots',
    async (withPhoto) => {
      const user = userEvent.setup();
      const { container } = renderPlacement();
      await screen.findByRole('textbox', { name: '推导过程' });
      fireEvent.change(screen.getByRole('textbox', { name: '推导过程' }), {
        target: { value: '差商为 ((3+h)²−9)/h = 6+h，令 h 趋于 0 得到瞬时变化率。' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '导数数值' }), {
        target: { value: '   ' },
      });
      if (withPhoto) {
        const input = container.querySelector('input[type="file"]');
        if (!(input instanceof HTMLInputElement)) throw new Error('Missing evidence input.');
        await user.upload(
          input,
          new File(['handwritten derivation'], 'derivation.png', {
            type: 'image/png',
          }),
        );
        await screen.findByRole('button', { name: '移除derivation.png' });
      }
      const next = screen.getByRole('button', { name: '下一题' });
      expect(next).toHaveProperty('disabled', true);
      await user.click(next);
      expect(mocks.submitProbeAnswer).not.toHaveBeenCalled();

      fireEvent.change(screen.getByRole('textbox', { name: '导数数值' }), {
        target: { value: ' 6.0 ' },
      });
      expect(next).toHaveProperty('disabled', false);
      await user.click(next);
      await waitFor(() => expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1));
      expect(mocks.submitProbeAnswer.mock.calls[0][0].assessment).toMatchObject({
        issuance_id: 'iss_placement_1',
        evaluation_group_id: 'eg_placement_1',
        submission_id: 'sub_placement_1',
        idempotency_key: 'key_placement_1',
        response_set: {
          entries: [
            {
              kind: 'text',
              slot_id: 'derivation',
              text_md: '差商为 ((3+h)²−9)/h = 6+h，令 h 趋于 0 得到瞬时变化率。',
            },
            { kind: 'numeric', slot_id: 'derivative', raw_input: ' 6.0 ', value: 6 },
          ],
        },
        group_evidence: withPhoto
          ? [
              {
                evidence: { ...photo, evidence_id: 'evidence_photo_derivation' },
                target: { scope: 'all_units' },
              },
            ]
          : [],
      });
    },
  );

  it.each(coverageCases)(
    '$label permits photo-only submission=$covered',
    async ({ targets, requirementKind, covered }) => {
      const question = modelQuestion();
      const dto = question.assessment.state.practice_dto;
      if (!dto) throw new Error('Placement fixture must include its frozen question.');
      if (requirementKind === 'missing') dto.response_requirements = undefined;
      if (requirementKind === 'deterministic') {
        dto.response_requirements = [
          { slot_id: 'derivation', evidence_unit_ids: [] },
          { slot_id: 'derivative', evidence_unit_ids: [] },
        ];
      }
      if (requirementKind === 'mixed') {
        dto.response_requirements = [
          { slot_id: 'derivation', evidence_unit_ids: ['unit_limit', 'unit_reasoning'] },
          { slot_id: 'derivative', evidence_unit_ids: [] },
        ];
      }
      const groupEvidence = targets.map((target, index) => ({
        evidence: {
          ...photo,
          evidence_id: `handwritten_page_${index}`,
          asset: { ...photo.asset, asset_id: `photo_page_${index}` },
        },
        target,
      }));
      question.assessment.state.draft = {
        evaluation_group_ref: null,
        updated_at: '2026-10-05T12:00:00.000Z',
        response_set: { entries: [] },
        group_evidence: groupEvidence,
        save_epoch: 4,
      };
      const user = userEvent.setup();
      renderPlacement(question);
      await screen.findByRole('textbox', { name: '导数数值' });
      const next = screen.getByRole('button', { name: '下一题' });
      expect(next).toHaveProperty('disabled', !covered);
      await user.click(next);
      if (covered) {
        await waitFor(() => expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1));
        expect(mocks.submitProbeAnswer.mock.calls[0][0].assessment).toEqual({
          issuance_id: 'iss_placement_1',
          evaluation_group_id: 'eg_placement_1',
          submission_id: 'sub_placement_1',
          idempotency_key: 'key_placement_1',
          response_set: { entries: [] },
          group_evidence: groupEvidence,
        });
      } else {
        expect(mocks.submitProbeAnswer).not.toHaveBeenCalled();
      }
    },
  );

  it.each([true, false])(
    'requires an original upload receipt for photo-only submission, original=%s',
    async (hasOriginal) => {
      if (!hasOriginal) {
        mocks.uploadAsset.mockResolvedValue({
          id: 'photo_derivation',
          storage_key: 'placement/legacy.png',
          mime_type: 'image/png',
          sha256: 'a'.repeat(64),
          byte_size: 4096,
        });
      }
      const user = userEvent.setup();
      const { container } = renderPlacement(modelQuestion());
      await screen.findByRole('textbox', { name: '导数数值' });
      const input = container.querySelector('input[type="file"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing evidence input.');
      await user.upload(
        input,
        new File(['handwritten derivation'], 'derivation.png', {
          type: 'image/png',
        }),
      );
      await screen.findByRole('button', { name: '移除derivation.png' });
      const next = screen.getByRole('button', { name: '下一题' });
      expect(next).toHaveProperty('disabled', !hasOriginal);
      await user.click(next);
      if (hasOriginal) {
        await waitFor(() => expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1));
        expect(mocks.submitProbeAnswer.mock.calls[0][0].assessment).toMatchObject({
          response_set: { entries: [] },
          group_evidence: [
            {
              evidence: { ...photo, evidence_id: 'evidence_photo_derivation' },
              target: { scope: 'all_units' },
            },
          ],
        });
      } else {
        expect(mocks.submitProbeAnswer).not.toHaveBeenCalled();
      }
    },
  );

  it('combines model evidence with a direct answer to the deterministic slot', async () => {
    const question = modelQuestion();
    const dto = question.assessment.state.practice_dto;
    if (!dto) throw new Error('Placement fixture must include its frozen question.');
    dto.response_requirements = [
      { slot_id: 'derivation', evidence_unit_ids: ['unit_limit', 'unit_reasoning'] },
      { slot_id: 'derivative', evidence_unit_ids: [] },
    ];
    const groupEvidence: GroupEvidenceT[] = [
      {
        evidence: photo,
        target: { scope: 'units', scoring_unit_ids: ['unit_limit', 'unit_reasoning'] },
      },
    ];
    question.assessment.state.draft = {
      evaluation_group_ref: null,
      updated_at: '2026-10-05T12:00:00.000Z',
      response_set: { entries: [] },
      group_evidence: groupEvidence,
      save_epoch: 4,
    };
    const user = userEvent.setup();
    renderPlacement(question);
    await screen.findByRole('textbox', { name: '导数数值' });
    expect(screen.getByRole('button', { name: '下一题' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox', { name: '导数数值' }), {
      target: { value: '6' },
    });
    expect(screen.getByRole('button', { name: '下一题' })).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: '下一题' }));
    await waitFor(() => expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1));
    expect(mocks.submitProbeAnswer.mock.calls[0][0].assessment).toMatchObject({
      response_set: {
        entries: [{ kind: 'numeric', slot_id: 'derivative', raw_input: '6', value: 6 }],
      },
      group_evidence: groupEvidence,
    });
  });

  it.each([false, true])(
    'retries the original accepted submission unchanged with newer draft=%s',
    async (hasNewerDraft) => {
      const question = multiSlotQuestion();
      const accepted = {
        submission_id: 'accepted_original',
        evaluation_group_id: 'accepted_group',
        idempotency_key: 'accepted_key',
        submitted_at: '2026-10-05T00:00:00.000Z',
        response_set: {
          entries: [
            {
              kind: 'text',
              slot_id: 'derivation',
              text_md: '原先接收的部分推导，必须按原文重试。',
            },
          ],
        },
        group_evidence: [
          { evidence: photo, target: { scope: 'units', scoring_unit_ids: ['unit_limit'] } },
        ],
      } satisfies (typeof question.assessment.state.submissions)[number];
      question.assessment.phase = 'retry';
      question.assessment.state.submissions = [accepted];
      if (hasNewerDraft) {
        question.assessment.state.draft = {
          evaluation_group_ref: null,
          updated_at: '2026-10-05T12:00:00.000Z',
          response_set: {
            entries: [
              {
                kind: 'text',
                slot_id: 'derivation',
                text_md: '较新的完整草稿不能覆盖已接收作答。',
              },
              { kind: 'numeric', slot_id: 'derivative', raw_input: '6', value: 6 },
            ],
          },
          group_evidence: [
            { evidence: { ...photo, evidence_id: 'draft_photo' }, target: { scope: 'all_units' } },
          ],
          save_epoch: 8,
        };
      }
      mocks.submitProbeAnswer.mockRejectedValueOnce(new Error('lost retry receipt'));
      mocks.placementNext.mockResolvedValueOnce({
        done: false,
        question,
        answeredCount: 0,
        sourcingNeeded: false,
      });
      const user = userEvent.setup();
      renderPlacement(question);
      await screen.findByRole('textbox', { name: '导数数值' });
      expect(screen.getByRole('textbox', { name: '推导过程' })).toHaveProperty('disabled', true);
      expect(screen.getByRole('textbox', { name: '导数数值' })).toHaveProperty('disabled', true);
      await user.click(screen.getByRole('button', { name: '继续处理已接收作答' }));
      await screen.findByText('lost retry receipt');
      await user.click(screen.getByRole('button', { name: '重新查询状态' }));
      await user.click(await screen.findByRole('button', { name: '继续处理已接收作答' }));
      await waitFor(() => expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(2));
      for (const [input] of mocks.submitProbeAnswer.mock.calls) {
        expect(input).toMatchObject({
          assessment: {
            issuance_id: 'iss_placement_1',
            evaluation_group_id: 'accepted_group',
            submission_id: 'accepted_original',
            idempotency_key: 'accepted_key',
            response_set: accepted.response_set,
            group_evidence: accepted.group_evidence,
          },
          responseMd: '原先接收的部分推导，必须按原文重试。',
          answerImageRefs: ['photo_derivation'],
          latencyMs: null,
        });
      }
      expect(mocks.saveResponseDraft).not.toHaveBeenCalled();
    },
  );
});
