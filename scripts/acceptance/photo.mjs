import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, api, grade, poll, readJson, report, save, sha, sql, success } from './lib.mjs';

const symbols = {
  alpha: 'α',
  theta: 'θ',
  pi: 'π',
  perp: '⊥',
  cdot: '·',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  in: '∈',
  cap: '∩',
  varnothing: '∅',
  emptyset: '∅',
  infty: '∞',
  circ: '°',
  triangle: '△',
  Omega: 'Ω',
  mid: '|',
  pm: '±',
  cdots: '⋯',
  sqrt: '√',
  mathbb: '',
  mathrm: '',
  vec: '',
  left: '',
  right: '',
  middle: '',
  dfrac: 'frac',
  tfrac: 'frac',
  quad: '',
  begin: '',
  end: '',
  cases: '',
};
export function norm(t = '') {
  return String(t ?? '')
    .replace(/\n[A-D]\..*/s, '')
    .replace(/^\s*\d+\.\s*/, '')
    .replace(/\(\d\)\.?/g, '')
    .replaceAll('（1）', '')
    .replaceAll('（2）', '')
    .replaceAll('\\(', '')
    .replaceAll('\\)', '')
    .replaceAll('$', '')
    .replace(/\\(?:d?frac)\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\([A-Za-z]+)/g, (_, s) => symbols[s] ?? s)
    .replace(
      /[²³⁶₀₁₂₃₇ₙ]/g,
      (s) =>
        ({
          '²': '2',
          '³': '3',
          '⁶': '6',
          '₀': '0',
          '₁': '1',
          '₂': '2',
          '₃': '3',
          '₇': '7',
          ₙ: 'n',
        })[s],
    )
    .normalize('NFKC')
    .replace(/[\s{}\\^_,，。、；;:：（）()[\]|]/g, '')
    .replaceAll('frac', '');
}
export function accuracy(a, b) {
  const x = Array.from(norm(a));
  const y = Array.from(norm(b));
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length, 1);
}
export async function fixtures() {
  const manifest = await readJson(join(ROOT, 'gold/manifest.json'));
  for (const [file, digest] of Object.entries(manifest)) {
    if (sha(await readFile(join(ROOT, 'gold', file))) !== digest)
      throw new Error(`Fixture changed: ${file}`);
  }
  const gold = await readJson(join(ROOT, 'gold/gold.json'));
  if (gold.pages.length !== 14 || gold.pages.flatMap((p) => p.questions).length !== 21)
    throw new Error('Gold denominator changed');
  return gold;
}
function choiceMatch(expected, q, dto) {
  const slots = dto?.response_spec?.slots ?? [];
  const options = slots.find((s) => s.kind === 'single_choice')?.options;
  if (options)
    return (
      Object.entries(expected).every(([label, text]) =>
        options.some((o) => o.label === label && norm(o.text) === norm(text)),
      ) && options.length === Object.keys(expected).length
    );
  const choices = q.choices_md;
  if (Array.isArray(choices))
    return (
      choices.length === Object.keys(expected).length &&
      choices.every(
        (text, i) =>
          norm(typeof text === 'string' ? text.replace(/^[A-D][.．、]\s*/, '') : text.text) ===
          norm(Object.values(expected)[i]),
      )
    );
  if (choices && typeof choices === 'object')
    return (
      Object.keys(choices).length === Object.keys(expected).length &&
      Object.entries(expected).every(([k, v]) => norm(v) === norm(choices[k]))
    );
  return false;
}
export async function photo(ctx) {
  const gold = await fixtures();
  if (!ctx.live)
    return report(
      ctx,
      'photo',
      {},
      {
        dry_run: true,
        pages: gold.pages.length,
        questions: 21,
        batches: [5, 5, 4],
        requests: [
          'POST /api/assets (14 files; M06-scan.jpg)',
          'POST /api/ingestion-sessions (3)',
          'POST operations kind=extract (3)',
          'GET blocks; import unchanged extracted fields when needed',
          'GET question; POST issuance + solve-session + gold submission',
        ],
        paid: false,
      },
    );
  const before = await sql(ctx, 'select id,name,approval_status from knowledge');
  const rows = [];
  const pages = [];
  const failures = [];
  for (const batch of [gold.pages.slice(0, 5), gold.pages.slice(5, 10), gold.pages.slice(10)]) {
    const assets = [];
    for (const p of batch) {
      const file = p.page === 'M06' ? 'M06-scan.jpg' : `${p.page}.png`;
      const bytes = await readFile(join(ROOT, 'gold/png', file));
      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes], { type: file.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }),
        file,
      );
      const uploaded = success(
        await api(ctx, 'POST', '/api/assets', form, {
          inputDigest: sha(bytes),
          requestEvidence: { file, sha256: sha(bytes) },
        }),
      );
      assets.push(uploaded.asset.id);
      await save(ctx.out, `upload-${p.page}.json`, {
        file,
        sha256: sha(bytes),
        asset_id: uploaded.asset.id,
      });
    }
    const s = success(
      await api(ctx, 'POST', '/api/ingestion-sessions', {
        entrypoint: 'vision_paper',
        asset_ids: assets,
      }),
    ).session;
    ctx.sessions.push(s.id);
    await save(ctx.out, 'sessions.json', ctx.sessions);
    const op = success(
      await api(
        ctx,
        'POST',
        `/api/ingestion-sessions/${s.id}/operations`,
        { kind: 'extract' },
        { headers: { 'Idempotency-Key': `${ctx.id}-extract-${s.id}` } },
      ),
    );
    const terminal = await poll(
      ctx,
      `/api/ingestion-operations/${op.id}`,
      (o) => ['succeeded', 'failed', 'cancelled'].includes(o.status),
      performance.now() + 600000,
    );
    if (terminal?.status !== 'succeeded') failures.push({ session: s.id, extraction: terminal });
    const enrollment = await poll(
      ctx,
      `/api/ingestion/${s.id}/blocks`,
      (x) =>
        x.rows.length > 0 &&
        x.rows.every((b) => b.imported_question_id || b.auto_enroll_observation),
      performance.now() + 60000,
    );
    const blocks = enrollment?.rows ?? [];
    // No gold values, forced KC approvals, repair text or fabricated wrong answers enter import.
    for (const b of blocks.filter(
      (x) =>
        !x.imported_question_id &&
        x.extracted_prompt_md &&
        (x.structured?.knowledge_ids?.length ||
          x.auto_enroll_observation?.suggested_knowledge_ids?.length),
    )) {
      const imported = await api(
        ctx,
        'POST',
        `/api/ingestion-sessions/${s.id}/operations`,
        {
          kind: 'import',
          input: {
            blocks: [
              {
                block_id: b.id,
                source_block_ids: [b.id],
                page_spans: b.page_spans,
                image_refs: b.image_refs,
                final_prompt_md: b.extracted_prompt_md,
                final_reference_md: b.reference_md,
                final_wrong_answer_md: b.wrong_answer_md ?? '',
                outcome: b.wrong_answer_md ? 'failure' : 'unanswered',
                knowledge_ids:
                  b.structured?.knowledge_ids ?? b.auto_enroll_observation.suggested_knowledge_ids,
                cause: null,
                question_kind: b.structured?.type ?? 'exercise',
              },
            ],
          },
        },
        { headers: { 'Idempotency-Key': `${ctx.id}-import-${b.id}` } },
      );
      if (imported.status < 300)
        await poll(
          ctx,
          `/api/ingestion-operations/${imported.body.id}`,
          (o) => ['succeeded', 'failed', 'cancelled'].includes(o.status),
          performance.now() + 180000,
        );
    }
    const final = success(await api(ctx, 'GET', `/api/ingestion/${s.id}/blocks`)).rows;
    const unused = new Set(final.map((_, i) => i));
    for (let pageIndex = 0; pageIndex < batch.length; pageIndex++) {
      const p = batch[pageIndex];
      const own = final.filter((b) => b.page_spans.some((span) => span.page_index === pageIndex));
      const pageRows = [];
      for (const g of p.questions) {
        // Highest textual match within its source page; preserve extras and missing questions.
        const candidates = [...unused]
          .filter((i) => final[i].page_spans.some((span) => span.page_index === pageIndex))
          .sort(
            (a, b) =>
              accuracy(g.stem, final[b].extracted_prompt_md) -
              accuracy(g.stem, final[a].extracted_prompt_md),
          );
        const index = candidates.find((i) => accuracy(g.stem, final[i].extracted_prompt_md) >= 0.5);
        const b = index === undefined ? null : final[index];
        if (b) unused.delete(index);
        let q = {};
        let issued = null;
        let graded = null;
        let failure = null;
        if (b?.imported_question_id) {
          q = success(await api(ctx, 'GET', `/api/questions/${b.imported_question_id}`));
          const issuance = await api(ctx, 'POST', '/api/issuances', {
            group_id: b.imported_question_id,
            mode: 'auto_score',
          });
          if (issuance.status < 300) {
            issued = issuance.body;
            try {
              graded = await grade(ctx, b.imported_question_id, issued, g.answer);
            } catch (e) {
              failure = e.message;
            }
          } else failure = `issuance HTTP ${issuance.status}`;
        }
        const dto = issued?.practice_dto;
        const figures = q.figures ?? [];
        const kc = await sql(
          ctx,
          'select id,name,domain,approval_status from knowledge where id=any($1::text[])',
          [q.knowledge_ids ?? []],
        );
        const required = g.figure_required === true;
        const row = {
          qid: g.qid,
          page: p.page,
          block_id: b?.id ?? null,
          question_id: b?.imported_question_id ?? null,
          stem_accuracy: b ? accuracy(g.stem, q.prompt_md ?? b.extracted_prompt_md) : 0,
          type:
            q.kind === g.type ||
            (g.type === 'single_choice' &&
              dto?.response_spec.slots.some((s) => s.kind === 'single_choice')),
          choices: g.choices ? choiceMatch(g.choices, q, dto) : null,
          answer: Boolean(q.reference_md) && norm(q.reference_md) === norm(g.answer),
          answer_semantics:
            'Human review required for equivalent nonidentical solutions; no LLM wording pass',
          figure_required: required,
          figure: figures.some((f) => f.source_page_index === pageIndex),
          foreign_figures: figures.filter((f) => f.source_page_index !== pageIndex).length,
          kc_exact: kc.length === g.kcs.length && g.kcs.every((k) => kc.some((x) => x.name === k)),
          kc_expected: g.kcs,
          kc_actual: kc,
          served: Boolean(dto),
          served_and_gradable: graded?.effective === true,
          grading_ms: graded?.response.ms ?? null,
          grade: graded?.response.body ?? null,
          failure,
        };
        rows.push(row);
        pageRows.push(row);
        await save(ctx.out, 'photo-progress.json', { rows, failures });
      }
      pages.push({
        page: p.page,
        expected_count: p.questions.length,
        extracted_count: own.length,
        count_ok: own.length === p.questions.length,
        stem_accuracy: pageRows.reduce((n, r) => n + r.stem_accuracy, 0) / p.questions.length,
        type: pageRows.filter((r) => r.type).length,
        choices: pageRows.filter((r) => r.choices).length,
        answers: pageRows.filter((r) => r.answer).length,
        figures: pageRows.filter((r) => r.figure_required && r.figure && r.foreign_figures === 0)
          .length,
        kcs: pageRows.filter((r) => r.kc_exact).length,
        served_and_gradable: pageRows.filter((r) => r.served_and_gradable).length,
      });
    }
    failures.push(...[...unused].map((i) => ({ extra_block: final[i].id, session: s.id })));
  }
  const count = (predicate) => rows.filter(predicate).length;
  const after = await sql(ctx, 'select id,name,approval_status,proposed_by_ai from knowledge');
  const added = after.filter((k) => !before.some((old) => old.id === k.id));
  const kcGuard = {
    added,
    auto_approved: added.filter((k) => k.approval_status === 'approved'),
    goal_as_kc: added.filter((k) => /系统性学习|学习目标/.test(k.name)),
    note: 'Names only flag candidates; human domain review must confirm Goal vs KC.',
  };
  await report(
    ctx,
    'photo',
    {
      photo_count: { passed: count((r) => r.block_id), total: 21 },
      photo_stem_accuracy: rows.reduce((n, r) => n + r.stem_accuracy, 0) / 21,
      photo_type: { passed: count((r) => r.type), total: 21 },
      photo_choices: { passed: count((r) => r.choices), total: 10 },
      photo_answers: { passed: count((r) => r.answer), total: 21 },
      photo_kc_exact: count((r) => r.kc_exact),
      photo_figures: {
        passed: count((r) => r.figure_required && r.figure && r.foreign_figures === 0),
        total: 4,
      },
      photo_served_gradable: {
        passed: count((r) => r.served_and_gradable),
        total: count((r) => r.served),
      },
      photo_served_total: count((r) => r.served),
      kc_auto_approved: kcGuard.auto_approved.length,
    },
    { rows, pages, failures, kc_guard: kcGuard },
  );
  await writeFile(
    join(ctx.out, 'photo-pages.md'),
    `| Page | Count actual/expected | Stem | Type | Choices | Answer | Figure | KC | Served + graded |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${pages.map((p) => `| ${p.page} | ${p.extracted_count}/${p.expected_count} | ${p.stem_accuracy.toFixed(3)} | ${p.type} | ${p.choices} | ${p.answers} | ${p.figures} | ${p.kcs} | ${p.served_and_gradable} |`).join('\n')}\n`,
  );
}
