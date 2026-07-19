import { describe, expect, it } from 'vitest';
import {
  JYEOO_EXIT,
  classifyJyeooExit,
  isForeignSourceHost,
  isImageDependentQuestion,
  parseJyeooLine,
} from './jyeoo-loom-adapter';

// A minimal valid jyeoo → loom envelope (question aligned with SourcedQuestion; jyeoo
// extension block loose). Helpers let each test tweak one field.
function envelope(
  overrides: Record<string, unknown> = {},
  jyeoo: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    question: {
      kind: 'choice',
      prompt_md: '若 $f(x)=\\ln x$，则 $f(1)=$（　）',
      reference_md: '【答案】B\n\n【解答】$f(1)=0$。',
      choices_md: ['A．2', 'B．0', 'C．4', 'D．5'],
      judge_kind_override: 'exact',
      difficulty: 3,
      knowledge_ids: [],
      source_url: 'https://www.jyeoo.com/math2/ques/detail/abc123',
      source_title: '（2026•孝南区校级三模）',
      extraction_hash: 'sha256:9f2c',
      extract: '若 f(x)=ln x，则 f(1)= 答案：B',
      ...overrides,
    },
    jyeoo: { id: 'abc123', subject: 'math2', knowledge_hints: ['函数'], vip: true, ...jyeoo },
  });
}

describe('parseJyeooLine', () => {
  it('parses a valid envelope into a SourcedQuestion + jyeoo meta', () => {
    const parsed = parseJyeooLine(envelope());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.question.kind).toBe('choice');
    expect(parsed.question.source_url).toContain('jyeoo.com');
    expect(parsed.question.knowledge_ids).toEqual([]);
    expect(parsed.jyeoo.vip).toBe(true);
    expect(parsed.jyeoo.id).toBe('abc123');
  });

  it('signals a blank line for skipping (whitespace-only)', () => {
    const parsed = parseJyeooLine('   ');
    expect(parsed).toEqual({ ok: false, reason: 'blank' });
  });

  it('rejects a malformed JSON line', () => {
    const parsed = parseJyeooLine('{"question": {broken');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/json parse/);
  });

  it('rejects an envelope whose question violates SourcedQuestion (empty prompt)', () => {
    const parsed = parseJyeooLine(envelope({ prompt_md: '' }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toMatch(/envelope invalid/);
  });

  it('rejects an envelope missing the required extract (fabricated-URL guard)', () => {
    const parsed = parseJyeooLine(envelope({ extract: undefined }));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a non-jyeoo (non-URL) source_url', () => {
    const parsed = parseJyeooLine(envelope({ source_url: 'not-a-url' }));
    expect(parsed.ok).toBe(false);
  });

  it('accepts an envelope with no jyeoo block (defaults to {})', () => {
    const line = JSON.stringify({
      question: JSON.parse(envelope()).question,
    });
    const parsed = parseJyeooLine(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.jyeoo).toEqual({});
  });
});

describe('classifyJyeooExit', () => {
  it('exit 0 clean → no failure', () => {
    expect(classifyJyeooExit({ exitCode: JYEOO_EXIT.OK, signal: null, timedOut: false })).toEqual({
      failure: null,
      retryable: false,
    });
  });

  it('exit 3 → auth (terminal)', () => {
    expect(classifyJyeooExit({ exitCode: 3, signal: null, timedOut: false })).toEqual({
      failure: 'auth',
      retryable: false,
    });
  });

  it('exit 6 → vip (terminal)', () => {
    expect(classifyJyeooExit({ exitCode: 6, signal: null, timedOut: false })).toEqual({
      failure: 'vip',
      retryable: false,
    });
  });

  it('exit 4 → network (retryable)', () => {
    expect(classifyJyeooExit({ exitCode: 4, signal: null, timedOut: false })).toEqual({
      failure: 'network',
      retryable: true,
    });
  });

  it('exit 5 → parse (terminal)', () => {
    expect(classifyJyeooExit({ exitCode: 5, signal: null, timedOut: false }).failure).toBe('parse');
  });

  it('exit 2 → args (terminal)', () => {
    expect(classifyJyeooExit({ exitCode: 2, signal: null, timedOut: false }).failure).toBe('args');
  });

  it('timeout → timeout (retryable), regardless of exit code', () => {
    expect(classifyJyeooExit({ exitCode: null, signal: 'SIGKILL', timedOut: true })).toEqual({
      failure: 'timeout',
      retryable: true,
    });
  });

  it('killed by signal (no timeout) → spawn (terminal)', () => {
    expect(classifyJyeooExit({ exitCode: null, signal: 'SIGSEGV', timedOut: false })).toEqual({
      failure: 'spawn',
      retryable: false,
    });
  });

  it('unknown non-zero exit → unknown (terminal)', () => {
    expect(classifyJyeooExit({ exitCode: 99, signal: null, timedOut: false }).failure).toBe(
      'unknown',
    );
  });
});

describe('isImageDependentQuestion', () => {
  const base = JSON.parse(envelope()).question;

  it('false for a pure-text question', () => {
    expect(isImageDependentQuestion(base)).toBe(false);
  });

  it('true when the stem carries a markdown image', () => {
    expect(
      isImageDependentQuestion({
        ...base,
        prompt_md: '如图所示 ![图](https://www.jyeoo.com/x.png)',
      }),
    ).toBe(true);
  });

  it('true when a choice carries a markdown image', () => {
    expect(
      isImageDependentQuestion({
        ...base,
        choices_md: ['A．正确', 'B．![图](https://www.jyeoo.com/b.png)'],
      }),
    ).toBe(true);
  });

  it('detects an image in the worked solution (reference_md renders to the learner)', () => {
    // The full solution card shows reference_md to the learner (HintLadder), so a rotting
    // image there corrupts the learner-visible page just like one in the stem.
    expect(
      isImageDependentQuestion({
        ...base,
        reference_md: '解答见 ![图](https://www.jyeoo.com/s.png)',
      }),
    ).toBe(true);
  });

  it('detects an image whose URL contains a literal ) (over-inclusive marker match)', () => {
    // A balanced-paren / [^)]* regex would stop at the first ) inside Foo_(bar) and miss
    // the image; the marker-structure match (`![...](`) catches it. Over-filter > under-filter.
    expect(
      isImageDependentQuestion({
        ...base,
        prompt_md: '如图 ![f](https://www.jyeoo.com/Foo_(bar).png) 所示',
      }),
    ).toBe(true);
  });
});

describe('isForeignSourceHost', () => {
  const HOST = 'www.jyeoo.com';
  it('accepts the exact jyeoo host', () => {
    expect(isForeignSourceHost('https://www.jyeoo.com/math2/ques/detail/abc', HOST)).toBe(false);
  });
  it('is case-insensitive on the host', () => {
    expect(isForeignSourceHost('https://WWW.JYEOO.COM/math2/ques/detail/abc', HOST)).toBe(false);
  });
  it('rejects a foreign host', () => {
    expect(isForeignSourceHost('https://mirror.example.com/math2/ques/detail/abc', HOST)).toBe(
      true,
    );
  });
  it('rejects a look-alike host that only SUFFIXES the jyeoo host', () => {
    // exact-hostname match, so www.jyeoo.com.evil.com is foreign (a suffix regex would miss it).
    expect(isForeignSourceHost('https://www.jyeoo.com.evil.com/x', HOST)).toBe(true);
  });
  it('rejects an unparseable url', () => {
    expect(isForeignSourceHost('not-a-url', HOST)).toBe(true);
  });
});
