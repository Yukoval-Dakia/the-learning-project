// Loft-language demos for the showcase (YUK-1473): the mascot, the shared-title morph, quote and
// capture flights, companion reply phases and the submit → judgment transition. Local sample data
// and timers only; nothing here fetches or writes (I1, I4).
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CompanionMessage, type ReplyPhase } from '../companion';
import {
  type MascotMode,
  MascotSlot,
  mascotSupport,
  useMascot,
  useMascotActivity,
} from '../mascot';
import { flyCapture, flyQuote } from '../motion/flights';
import { useSharedMorph } from '../motion/morph';
import { reveal } from '../motion/reveal';
import { Button, Chip, IconButton, Judgment, type JudgmentPhase, Segmented } from '../primitives';
import { MASCOT_SIZE, PHONE_MEDIA } from '../tokens';

/* ── Sample data ─────────────────────────────────────── */

const QUESTIONS = [
  {
    id: 'q-ellipse',
    source: '学校作业 · 圆锥曲线练习 第 2 题',
    title: '椭圆综合题',
    due: '周五交',
  },
  { id: 'q-chord', source: '错题 · 上周', title: '弦长与面积的最大值', due: '待订正' },
  { id: 'q-vieta', source: '笔记里的例题', title: '设而不求：两根之和与积', due: '复习' },
] as const;

const STEPS = [
  '设 l：x = my + 1，代入椭圆，得到关于 y 的二次方程。',
  '两根之和与两根之积用 m 表示，不必解出交点。',
  '面积写成 ½·|F₁F₂|·|y₁ − y₂|，只剩参数 m。',
  '换元 t = √(m² + 1)，t ≥ 1，再看单调性。',
];

const REPLY =
  '第 4 步的换元本身没问题，问题在取等条件：均值不等式要在 t = √3/3 时取等，而 t ≥ 1，这个等号取不到。在 t ≥ 1 上它是单调递增的，所以应该看 t = 1。';

/* ── Conversation (companion reply phases, C3) ─────────── */

export interface DemoMessage {
  id: string;
  role: 'me' | 'companion';
  text: string;
  quote?: string;
  /** The page anchor this message is about (R5). */
  cites?: string;
  phase?: ReplyPhase;
  shown?: number;
}

let seq = 0;
const nextId = () => {
  seq += 1;
  return `demo-${seq}`;
};

export interface DemoConversation {
  messages: DemoMessage[];
  thinking: boolean;
  ask: (question: string, quote?: { text: string; cites: string; from: DOMRect | null }) => void;
}

/**
 * A fake run that walks one reply through 在想 → 生成中 → 记录中 → 已记录, and drives the mascot
 * with the same state, the way the real companion will from Copilot run status.
 */
export function useDemoConversation(): DemoConversation {
  const [messages, setMessages] = useState<DemoMessage[]>([
    { id: 'demo-0', role: 'me', text: '第 4 步哪里不对？' },
    { id: 'demo-0r', role: 'companion', text: REPLY, cites: '第 4 步' },
  ]);
  const [settled, setSettled] = useState(0);
  const timers = useRef<number[]>([]);
  const flight = useRef<{ id: string; text: string; from: DOMRect | null } | null>(null);
  const thinking = messages.some(
    (m) => m.phase === 'thinking' || m.phase === 'streaming' || m.phase === 'recording',
  );
  useMascotActivity({ thinking, settleKey: settled });

  const patch = useCallback((id: string, next: Partial<DemoMessage>) => {
    setMessages((all) => all.map((m) => (m.id === id ? { ...m, ...next } : m)));
  }, []);

  const ask = useCallback<DemoConversation['ask']>(
    (question, quote) => {
      const mine = nextId();
      const reply = nextId();
      if (quote) flight.current = { id: mine, text: quote.text, from: quote.from };
      setMessages((all) => [
        ...all,
        { id: mine, role: 'me', text: question, quote: quote?.text, cites: quote?.cites },
        {
          id: reply,
          role: 'companion',
          text: REPLY,
          cites: '第 4 步',
          phase: 'thinking',
          shown: 0,
        },
      ]);
      const later = (ms: number, run: () => void) => {
        timers.current.push(window.setTimeout(run, ms));
      };
      later(900, () => {
        let shown = 0;
        const tick = window.setInterval(() => {
          shown = Math.min(REPLY.length, shown + 3);
          patch(reply, { phase: 'streaming', shown });
          if (shown >= REPLY.length) {
            window.clearInterval(tick);
            patch(reply, { phase: 'recording' });
            // Production settles on the re-read committed state, never on the end of the stream.
            later(900, () => {
              patch(reply, { phase: 'settled' });
              setSettled((n) => n + 1);
            });
          }
        }, 40);
        timers.current.push(tick);
      });
    },
    [patch],
  );

  // The quoted passage lifts off the page and lands as this message's quote (M6). Runs when a
  // message is added, before the new quote paints.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is the trigger
  useLayoutEffect(() => {
    const f = flight.current;
    if (!f) return;
    flight.current = null;
    const landing = () => {
      for (const el of document.querySelectorAll<HTMLElement>(
        `[data-demo-msg="${f.id}"] .un-msg-quote`,
      )) {
        if (el.offsetParent) return el;
      }
      return null;
    };
    flyQuote({ from: f.from, content: f.text, to: landing });
  }, [messages.length]);

  useLayoutEffect(
    () => () => {
      for (const t of timers.current) {
        window.clearTimeout(t);
        window.clearInterval(t);
      }
    },
    [],
  );

  return { messages, thinking, ask };
}

export function DemoThread({
  conversation,
  onReveal,
}: {
  conversation: DemoConversation;
  onReveal: (anchor: string) => void;
}) {
  return (
    <div className="un-showcase-thread">
      {conversation.messages.map((m) => (
        <div key={m.id} data-demo-msg={m.id} className="un-showcase-thread-item">
          <CompanionMessage
            role={m.role}
            phase={m.phase}
            cites={m.cites}
            quote={m.quote}
            onQuote={m.quote && m.cites ? () => onReveal(m.cites as string) : undefined}
            quoteLabel={m.cites ? `回到原文：${m.cites}` : undefined}
            reference={m.role === 'companion' ? m.cites : undefined}
            onReference={m.cites ? () => onReveal(m.cites as string) : undefined}
          >
            {m.shown !== undefined && m.phase !== 'settled' ? m.text.slice(0, m.shown) : m.text}
          </CompanionMessage>
        </div>
      ))}
    </div>
  );
}

/* ── Practice stage: stream ↔ question (M4), slot per view (B1) ── */

export function PracticeStage({
  conversation,
  openCompanion,
}: {
  conversation: DemoConversation;
  /** Make the companion visible (desktop panel or phone sheet) before a quote flies in. */
  openCompanion: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const morph = useSharedMorph(hostRef, open ?? 'stream');
  const [judgment, setJudgment] = useState<JudgmentPhase | null>(null);
  const mascot = useMascot();
  const checkTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(checkTimer.current), []);
  const question = QUESTIONS.find((q) => q.id === open);

  const enter = (id: string) => {
    morph.capture();
    setOpen(id);
    setJudgment(null);
  };
  const back = () => {
    morph.capture();
    setOpen(null);
  };
  const submit = () => {
    setJudgment('checking');
    window.clearTimeout(checkTimer.current);
    checkTimer.current = window.setTimeout(() => {
      setJudgment('settled');
      mascot.advance();
    }, 1100);
  };
  const askAbout = (step: number, el: HTMLElement | null) => {
    const anchor = `第 ${step + 1} 步`;
    openCompanion();
    conversation.ask('这一步能再讲清楚一点吗？', {
      text: STEPS[step] ?? '',
      cites: anchor,
      from: el?.getBoundingClientRect() ?? null,
    });
  };

  return (
    <div ref={hostRef} className="un-showcase-stage">
      <div className="un-page-enter" key={open ?? 'stream'}>
        {!question ? (
          <section className="un-showcase-banner" aria-labelledby="un-sc-stream">
            <div className="un-showcase-banner-text">
              <p className="un-showcase-eyebrow">做题 · 示例题目流</p>
              <h2 id="un-sc-stream" className="un-showcase-title">
                今晚可以做的
              </h2>
              <p className="un-showcase-muted">
                点一张卡片进入：标题从卡片长成页面标题，吉祥物弹到新位置。
              </p>
            </div>
            <MascotSlot
              size={MASCOT_SIZE.library}
              phoneSize={MASCOT_SIZE.libraryPhone}
              rest={{ x: -4, y: -8, z: 12 }}
            />
          </section>
        ) : (
          <section className="un-showcase-banner" aria-labelledby="un-sc-question">
            <div className="un-showcase-banner-text">
              <p className="un-showcase-eyebrow">
                <IconButton label="返回题目流" icon={<ArrowLeft size={16} />} onClick={back} />
                {question.source}
              </p>
              <h2 id="un-sc-question" className="un-showcase-title" data-morph={question.id}>
                {question.title}
              </h2>
              <p className="un-showcase-row">
                <Chip>{question.due}</Chip>
                <Chip tone="positive">第 (1) 问 正确</Chip>
                <Chip tone="caution">第 (2) 问 待订正</Chip>
              </p>
            </div>
            <MascotSlot
              size={MASCOT_SIZE.read}
              phoneSize={MASCOT_SIZE.readPhone}
              rest={{ x: -6, y: -12, z: 8 }}
              glow={9}
            />
          </section>
        )}

        {!question ? (
          <ul className="un-showcase-cards">
            {QUESTIONS.map((q) => (
              <li key={q.id}>
                <button type="button" className="un-showcase-card" onClick={() => enter(q.id)}>
                  <span className="un-showcase-eyebrow">{q.source}</span>
                  <span className="un-showcase-card-title" data-morph={q.id}>
                    {q.title}
                  </span>
                  <span className="un-showcase-muted">{q.due}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="un-showcase-stack">
            <h3 className="un-showcase-h">第 (2) 问 · 草稿</h3>
            <ol className="un-showcase-steps">
              {STEPS.map((text, i) => (
                <li key={text} className="un-showcase-step" data-anchor={`第 ${i + 1} 步`}>
                  <span className="un-showcase-step-n un-num">{i + 1}</span>
                  <p data-step-text>{text}</p>
                  <IconButton
                    label={`就第 ${i + 1} 步问学习伙伴`}
                    icon={<MessageSquare size={14} />}
                    onClick={(e) =>
                      askAbout(
                        i,
                        e.currentTarget.parentElement?.querySelector<HTMLElement>(
                          '[data-step-text]',
                        ) ?? null,
                      )
                    }
                  />
                </li>
              ))}
            </ol>
            <div className="un-showcase-row">
              <Button variant="primary" onClick={submit} disabled={judgment === 'checking'}>
                提交第 (2) 问
              </Button>
              {judgment && (
                <Button variant="ghost" onClick={() => setJudgment(null)}>
                  重做
                </Button>
              )}
            </div>
            {judgment && (
              <Judgment phase={judgment} tone="caution" label="与参考答案不一致（确定性核对）">
                <p>原因还没判断。可以先看第 4 步的取等条件，或者问学习伙伴。</p>
              </Judgment>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Lower the phone sheet before scrolling to a passage, so it is fully visible (R1, C4). */
export function revealAnchor(anchor: string, lowerSheet: () => void) {
  const el = document.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`);
  if (!el) return;
  if (window.matchMedia(PHONE_MEDIA).matches) {
    lowerSheet();
    window.setTimeout(() => reveal(el), 240);
  } else {
    reveal(el);
  }
}

/* ── Mascot controls ─────────────────────────────────── */

export function MascotControls({
  mode,
  onMode,
}: {
  mode: MascotMode;
  onMode: (mode: MascotMode) => void;
}) {
  const [thinking, setThinking] = useState(false);
  const [settleKey, setSettleKey] = useState(0);
  const [support, setSupport] = useState<string | null>(null);
  useMascotActivity({ thinking, settleKey });
  return (
    <div className="un-showcase-stack">
      <div className="un-showcase-row">
        <Segmented
          label="吉祥物绘制方式"
          value={mode}
          onChange={onMode}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'still', label: '静态图' },
            { value: 'off', label: '关闭' },
          ]}
        />
        <Button size="sm" aria-pressed={thinking} onClick={() => setThinking((t) => !t)}>
          {thinking ? '停止在想' : '在想'}
        </Button>
        <Button size="sm" onClick={() => setSettleKey((k) => k + 1)}>
          记录完成（前进一格）
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const s = mascotSupport();
            setSupport(s.render === 'gl' ? '这台设备画三维玻璃花' : `静态图：${s.reason}`);
          }}
        >
          检测这台设备
        </Button>
      </div>
      {support && <p className="un-showcase-muted">{support}</p>}
      <p className="un-showcase-muted">
        指针靠近（300px 内）时花会转向它；手机宽度下往下滚，花会缩进顶栏右侧。减少动态效果、没有
        WebGL、软件渲染或低性能设备用静态图。
      </p>
    </div>
  );
}

/* ── Capture flight (M5) ─────────────────────────────── */

/**
 * Write something down; it arcs into "收进来的" (the sidebar's `[data-showcase-pocket]`) or, at
 * phone width, into the tab bar's 记一下, and is counted only when it lands.
 */
export function CaptureDemo({ onLanded }: { onLanded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const save = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    const phone = window.matchMedia(PHONE_MEDIA).matches;
    flyCapture({
      from: inputRef.current?.getBoundingClientRect(),
      text: value,
      to: () =>
        document.querySelector(phone ? '[data-tab-target="capture"]' : '[data-showcase-pocket]'),
      onLand: onLanded,
    });
  };
  return (
    <form
      className="un-showcase-capture"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        ref={inputRef}
        className="un-showcase-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="记一下：一句话或一个问题"
        aria-label="记一下"
      />
      <Button type="submit" size="sm" variant="primary" disabled={!text.trim()}>
        记下
      </Button>
    </form>
  );
}
