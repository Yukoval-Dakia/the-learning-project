// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PfPaper } from './PfPaper';
import type { PaperSlot } from './practice-api';

const mocks = vi.hoisted(() => ({
  getPaperDetail: vi.fn(),
  savePaperAnswer: vi.fn(),
  submitPaperSlot: vi.fn(),
  endPaperSession: vi.fn(),
  pausePaperSession: vi.fn(),
  startPaperSession: vi.fn(),
}));
vi.mock('./practice-api', async () => ({
  ...(await vi.importActual<typeof import('./practice-api')>('./practice-api')),
  ...mocks,
}));

function slot(id: string, choice: boolean): PaperSlot {
  const responseSlot = choice
    ? {
        slot_id: `${id}-response`,
        part_id: id,
        kind: 'single_choice' as const,
        options: [
          { option_id: 'stable-upstream', label: 'A', text: '水流方向与船相反' },
          { option_id: 'stable-downstream', label: 'B', text: '水流方向与船相同' },
        ],
      }
    : { slot_id: `${id}-response`, part_id: id, kind: 'text' as const, math_preview: false };
  return {
    question_id: id,
    part_ref: null,
    section_index: 0,
    question: {
      id,
      kind: choice ? 'choice' : 'derivation',
      prompt_md: choice ? '判断逆水航行的方向。' : '列方程说明静水速度。',
      choices_md: null,
      difficulty: 3,
      notation: null,
      parent_question_id: null,
      part_index: null,
      image_refs: [],
    },
    slot_state: { draft: null, submission: null },
    assessment: {
      issuance_id: `issued-${id}`,
      evaluation_group_id: `group-${id}`,
      idempotency_key: `submit-${id}`,
      save_epoch: 0,
      practice_dto: {
        issuance_id: `issued-${id}`,
        revision_id: `revision-${id}`,
        issued_at: '2026-10-04T00:00:00.000Z',
        materials: [],
        faces: [{ part_id: id, prompt_md: '冻结原题', material_ids: [] }],
        response_spec: { slots: [responseSlot] },
      },
      response_set: { entries: [] },
      group_evidence: [],
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.savePaperAnswer.mockResolvedValue({ answer_id: 'draft', created: true, save_epoch: 1 });
  mocks.submitPaperSlot.mockResolvedValue({ visible_to_user: false, feedback_buffered: true });
  mocks.endPaperSession.mockResolvedValue({ ok: true });
  mocks.pausePaperSession.mockResolvedValue({ ok: true });
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) =>
    timeout(fn, ms === 800 ? 10 : ms, ...args),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('autosaves and submits stable native responses separately for each paper occurrence', async () => {
  const user = userEvent.setup();
  mocks.getPaperDetail.mockResolvedValue({
    artifact_id: 'paper-native',
    title: '冻结试卷',
    generation_status: 'ready',
    intent_source: 'review_plan',
    session: { id: 'session-native', status: 'started', pos: 0, right: 0, wrong: 0 },
    sections: [
      {
        section_index: 0,
        knowledge_focus_names: [],
        slots: [slot('choice', true), slot('reasoning', false)],
      },
    ],
  });
  const completed = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PfPaper
        artifactId="paper-native"
        onExit={vi.fn()}
        onSubmitted={completed}
        addToast={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole('radio', { name: /水流方向与船相反/ }));
  await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalled());
  expect(mocks.savePaperAnswer.mock.calls[0][1]).toMatchObject({
    expected_save_epoch: 0,
    assessment: {
      issuance_id: 'issued-choice',
      evaluation_group_id: 'group-choice',
      response_set: {
        entries: [{ slot_id: 'choice-response', kind: 'choice', option_ids: ['stable-upstream'] }],
      },
    },
  });
  await user.click(screen.getByRole('button', { name: '下一题' }));
  await user.type(
    await screen.findByRole('textbox', { name: '作答' }),
    'v+c=18，v-c=12，相加得 v=15 km/h。',
  );
  await user.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
  await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
  expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(2);
  expect(
    mocks.submitPaperSlot.mock.calls[0][1].assessment.response_set.entries[0].option_ids,
  ).toEqual(['stable-upstream']);
  expect(mocks.submitPaperSlot.mock.calls[1][1].assessment).toMatchObject({
    evaluation_group_id: 'group-reasoning',
    response_set: {
      entries: [
        {
          slot_id: 'reasoning-response',
          kind: 'text',
          text_md: 'v+c=18，v-c=12，相加得 v=15 km/h。',
        },
      ],
    },
  });
});
