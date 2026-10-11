import { api, grade, pause, report, requireValue, save, sql, success } from './lib.mjs';

const limits = {
  first_item_ms: 60000,
  grading_ms: 10000,
  first_help_ms: 20000,
  first_material_ms: 180000,
  total_wait_ms: 300000,
  journey_ms: 900000,
};
export async function emptyIdentity(ctx) {
  const tables = [
    'goal',
    'question',
    'event',
    'learning_session',
    'learning_item',
    'artifact',
    'memory_brief_note',
  ];
  const counts = {};
  for (const table of tables)
    counts[table] = Number((await sql(ctx, `select count(*) as n from ${table}`))[0].n);
  const memories = await sql(ctx, 'select count(*) as n from learning_project_memories');
  counts.memories = Number(memories[0].n);
  await save(ctx.out, 'empty-identity.json', counts);
  requireValue(
    Object.values(counts).every((n) => n === 0),
    'Empty learner database required; never clear a used database',
  );
  return counts;
}
export async function dayOne(ctx) {
  if (!ctx.live)
    return report(
      ctx,
      'day-one',
      {},
      {
        dry_run: true,
        limits,
        path: 'goal → learning intent + accept → placement → auto grading → help → material',
        friction: [
          'actions to first gradable item <=8',
          'self-rating share 0% (100% auto-gradable owner ruling supersedes old <=20%)',
          'photo transcription fields 0 (companion photo review)',
          'help without usable output 0',
          'wait >60s without visible progress/alternative 0',
        ],
        empty_database: 'Checked read-only before any write; curriculum taxonomy may be seeded',
        paid: false,
      },
    );
  await emptyIdentity(ctx);
  const before = await sql(ctx, 'select id,name,approval_status from knowledge');
  const start = performance.now();
  const steps = [];
  const metrics = {};
  const issues = [];
  const action = async (name, path, body, timeout = 30000) => {
    const r = await api(ctx, 'POST', path, body, { timeout });
    steps.push({
      name,
      ordinal: steps.length + 1,
      since_goal_ms: performance.now() - start,
      status: r.status,
      wait_ms: r.ms,
    });
    await save(ctx.out, 'day-one-progress.json', { steps, metrics, issues });
    return success(r);
  };
  let placement;
  let current;
  let firstItemActions = null;
  let readableAt = null;
  let material = null;
  const served = [];
  try {
    const goal = await action('submit goal', '/api/goals', {
      title: ctx.config.journey.topic,
      subjectId: ctx.config.journey.subject,
      declaredStage: 'high_school',
    });
    const proposal = await action(
      'request learning path',
      '/api/learning-intents',
      { topic: ctx.config.journey.topic },
      Math.max(1, limits.first_item_ms - (performance.now() - start)),
    );
    await action('confirm path', `/api/proposals/${proposal.proposal_id}/decisions`, {
      decision: 'accept',
    });
    placement = await action('start placement', '/api/placement-sessions', { goalId: goal.id });
    while (performance.now() - start < limits.first_item_ms && !placement.question) {
      await pause(500);
      // Rechecking is a learner action. No free polling discount for repeated "query again" clicks.
      const next = await action(
        'recheck placement',
        `/api/placement-sessions/${placement.sessionId}/question-selections`,
        {},
        Math.max(1, limits.first_item_ms - (performance.now() - start)),
      );
      placement = { ...placement, ...next };
      if (next.done) break;
    }
    current = placement.question;
    if (current) {
      const first = performance.now() - start;
      firstItemActions = steps.length;
      const assessment = current.assessment;
      requireValue(
        assessment?.practice_dto ?? assessment?.state?.practice_dto,
        'Placement did not expose a pinned public question',
      );
      const dto = assessment.practice_dto ?? assessment.state.practice_dto;
      const slot = dto.response_spec.slots.find((s) => s.kind !== 'table');
      // Scripted ignorance is legitimate. No private answer read is used to manufacture mastery.
      const answer =
        slot.kind === 'single_choice'
          ? slot.options[0].label
          : slot.kind === 'numeric'
            ? '0'
            : '我暂时不会，请按这次原始作答判分。';
      const graded = await grade(ctx, current.questionId, assessment, answer, {
        placement: placement.sessionId,
        timeout: limits.grading_ms,
      });
      metrics.grading_ms = graded.effective ? graded.response.ms : null;
      metrics.first_item_ms = graded.effective ? first : null;
      served.push({
        question_id: current.questionId,
        issuance_id: dto.issuance_id,
        effective: graded.effective,
        status: graded.response.body.status,
        response: graded.response.body,
      });
      if (!graded.effective)
        issues.push('First served item did not deliver automatic effective grading');
      const helpStart = performance.now();
      let help = null;
      try {
        const tutor = await action('open help', '/api/solve-sessions', {
          question_id: current.questionId,
          issuance_id: dto.issuance_id,
        });
        const hint = await api(
          ctx,
          'POST',
          `/api/solve-sessions/${tutor.session_id}/hint-requests`,
          { question_id: current.questionId, issuance_id: dto.issuance_id, hint_index: 0 },
          { timeout: Math.max(1, limits.first_help_ms - (performance.now() - helpStart)) },
        );
        steps.push({ name: 'request hint', wait_ms: hint.ms, status: hint.status });
        if (hint.status < 300 && hint.body.text_md?.trim())
          help = { source: 'hint', text_md: hint.body.text_md };
      } catch (e) {
        issues.push(e.message);
      }
      if (!help && performance.now() - helpStart < limits.first_help_ms) {
        const reference = await api(
          ctx,
          'POST',
          `/api/issuances/${dto.issuance_id}/reference-reveals`,
          {},
          { timeout: limits.first_help_ms - (performance.now() - helpStart) },
        );
        steps.push({
          name: 'choose frozen reference fallback',
          wait_ms: reference.ms,
          status: reference.status,
        });
        if (reference.status < 300) {
          const text = reference.body.reference_md ?? reference.body.feedback?.reference_md;
          if (text?.trim()) help = { source: 'frozen reference', text_md: text };
        }
      }
      metrics.first_help_ms = help ? performance.now() - helpStart : null;
      metrics.help_without_output = help ? 0 : 1;
      if (help?.source === 'frozen reference') {
        readableAt = performance.now() - start;
        material = help;
      }
      await save(ctx.out, 'help.json', { help, limit_ms: limits.first_help_ms });
    } else issues.push('No served item within 60 seconds');
  } catch (e) {
    issues.push(e.message);
  }
  // Notes can still deliver after the first-item gate fails; preserve that independent evidence.
  while (readableAt === null && performance.now() - start < limits.first_material_ms) {
    const notes = await api(ctx, 'GET', '/api/notes', undefined, {
      timeout: Math.max(1, limits.first_material_ms - (performance.now() - start)),
    });
    const rows = notes.body.rows ?? notes.body.data ?? [];
    for (const summary of rows.filter((n) => n.generation_status === 'ready')) {
      const detail = success(
        await api(ctx, 'GET', `/api/notes/${summary.id}`, undefined, {
          timeout: Math.max(1, limits.first_material_ms - (performance.now() - start)),
        }),
      );
      if (detail.sections?.some((section) => section.body_md?.trim())) {
        readableAt = performance.now() - start;
        material = {
          source: 'note API content (rendered readability awaits review)',
          note: detail,
        };
        break;
      }
    }
    if (readableAt !== null) break;
    await pause(1000);
  }
  const after = await sql(ctx, 'select id,name,approval_status,proposed_by_ai from knowledge');
  const added = after.filter((k) => !before.some((old) => old.id === k.id));
  metrics.kc_auto_approved = added.filter((k) => k.approval_status === 'approved').length;
  metrics.first_material_ms = readableAt;
  metrics.journey_ms = performance.now() - start;
  // Each request/poll interval is product waiting; include automatic grading, help and observer delays.
  metrics.total_wait_ms = metrics.journey_ms;
  metrics.actions_to_first_item = firstItemActions;
  metrics.served_gradable = served.length
    ? { passed: served.filter((q) => q.effective).length, total: served.length }
    : null;
  metrics.self_rating_share = served.length
    ? served.filter((q) => q.status === 'review_required').length / served.length
    : null;
  // These require the real browser and companion photo run. Never invent zero from API success.
  metrics.photo_transcription_fields = null;
  metrics.wait_without_visible_progress = null;
  const checks = Object.fromEntries(
    Object.entries(limits).map(([k, max]) => [
      k,
      metrics[k] == null
        ? 'FAIL_NO_DELIVERY'
        : metrics[k] <= max
          ? 'WITHIN_LIMIT_API'
          : 'FAIL_OVER_LIMIT',
    ]),
  );
  await report(ctx, 'day-one', metrics, {
    limits,
    checks,
    steps,
    served,
    issues,
    material,
    kc_guard: {
      added,
      goal_names_to_review: added.filter((k) => k.name === ctx.config.journey.topic),
    },
    variant: ctx.config.journey.variant,
    human_gates: [
      'Rendered first material readability and exact browser timestamp',
      'Actual click count and field transcription',
      'Visible progress/alternatives during waits',
      'Goal is not a KC',
      'Generation-unavailable fallback rerun on another empty TEST database',
    ],
  });
}
