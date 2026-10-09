// YUK-1353 · 标志物小样. Three forms × two renderers (CSS-3D light / WebGL real), each with a
// proposed palette, plus a live stage showing per-page size, position and orientation.
// Motion only on change: at rest nothing animates (WebGL stops rendering frames).
import './tokens.css';
import './base.css';
import './marks.css';
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createGLMark } from './mark-gl.js';

const FORMS = {
  knot: { name: '编织结', note: '一根线自己交织成三叶结，外绕一圈细环。呼应 Loom（织机）：分散的学习被织在一起。', palette: 'warm' },
  flower: { name: '几何花', note: '扁平的风车状花朵，透明玻璃材质，叶片有厚度、朝同一方向旋出。安静，换页时像风吹过一样转一点。', palette: 'warm' },
  surface: { name: '数学曲面', note: '单叶双曲面：由两族直线织成的曲面，腰线一圈强调色。理性、可推导，呼应题目里的几何。', palette: 'cool' },
};

const PALETTES = {
  warm: {
    light: { bg: '#faf9f5', ink: '#1f1e1d', accent: '#d97757', soft: '#f2d9c9', body: '#efe8dc', panel: '#ffffff', line: '#e3dfd5', muted: '#6b675f' },
    dark: { bg: '#171614', ink: '#f2efe8', accent: '#e8916e', soft: '#6b4436', body: '#3a3631', panel: '#1f1e1b', line: '#312f2c', muted: '#959188' },
  },
  cool: {
    light: { bg: '#f6f7f9', ink: '#16181d', accent: '#5e6ad2', soft: '#d9ddf5', body: '#e6e8ee', panel: '#ffffff', line: '#e2e4ea', muted: '#62666f' },
    dark: { bg: '#101115', ink: '#eceef3', accent: '#8b93ff', soft: '#3a3f6b', body: '#2a2d36', panel: '#17181d', line: '#262830', muted: '#8f939d' },
  },
};

// Per-page design: which slot the mark lives in, its size, and the orientation it settles to.
const PAGES = {
  home: { label: '回来时', slot: 'hero', size: 168, rot: { x: -18, y: 32, z: 0 }, spec: '首页：唯一以大尺寸出现的地方（168px），在问候语右侧，3/4 视角。快速记录成功时轻转 90°。' },
  question: { label: '看题', slot: 'copilot', size: 22, rot: { x: 12, y: -48, z: 6 }, spec: '看题：缩进 Copilot 侧栏的头部（22px），成为学习伙伴的“在场”标记；它思考时缓慢自转，结果生效即停。' },
  note: { label: '读笔记', slot: 'copilot', size: 22, rot: { x: 26, y: 64, z: -4 }, spec: '读笔记：同样在 Copilot 侧栏头部，朝向与看题不同——换页时它会转向新的方向。' },
  library: { label: '资料', slot: 'logo', size: 20, rot: { x: -6, y: 150, z: 0 }, spec: '资料列表：回到侧栏左上角作为 logo（20px），不参与内容，只在切换时转一点。' },
};

const BASE = 168;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Light renderer: SVG-free CSS 3D ──────────────────── */
function LightMark({ kind, rot, thinking, turns }) {
  const y = rot.y + turns * 90;
  return (
    <div className="lm">
      <div className="lm-rot" style={{ transform: `rotateX(${rot.x}deg) rotateY(${y}deg) rotateZ(${rot.z}deg)` }}>
        <div className={`lm-spin ${thinking ? 'is-thinking' : ''}`}>
          {kind === 'knot' && (
            <>
              {[0, 60, 120].map((a, i) => (
                <span key={a} className={`lm-ring ${i === 0 ? 'lm-ring-accent' : ''}`} style={{ transform: `rotateY(${a}deg) rotateX(72deg)` }} />
              ))}
              {[30, 90, 150].map((a) => (
                <span key={a} className="lm-ring lm-ring-thin" style={{ transform: `rotateY(${a}deg) rotateX(-40deg) scale(0.78)` }} />
              ))}
            </>
          )}
          {kind === 'flower' && (
            <>
              {Array.from({ length: 8 }, (_, i) => (
                <span key={`o${i}`} className="lm-petal" style={{ transform: `rotateZ(${i * 45}deg) rotateX(-34deg)` }} />
              ))}
              {Array.from({ length: 5 }, (_, i) => (
                <span key={`i${i}`} className="lm-petal lm-petal-inner" style={{ transform: `rotateZ(${18 + i * 72}deg) rotateX(-58deg) scale(0.62)` }} />
              ))}
              <span className="lm-core" />
            </>
          )}
          {kind === 'surface' &&
            Array.from({ length: 15 }, (_, i) => {
              const H = 70;
              const R = 70;
              const w = 35;
              const h = -H + (2 * H * i) / 14;
              const r = Math.sqrt(w * w + (R * R - w * w) * (h / H) ** 2);
              return (
                <span
                  key={i}
                  className={`lm-level ${i === 7 ? 'lm-level-waist' : ''}`}
                  style={{ width: r * 2, height: r * 2, transform: `translate(-50%, -50%) translateY(${h}px) rotateX(90deg)` }}
                />
              );
            })}
        </div>
      </div>
    </div>
  );
}

/* ── Real-3D renderer wrapper ─────────────────────────── */
function GLMark({ kind, rot, thinking, turns, pal, warm }) {
  const ref = useRef(null);
  const handle = useRef(null);
  const [err, setErr] = useState(null);
  const lastTurns = useRef(turns);
  // Latest props, so a renderer that finishes loading late still shows the current form.
  const latest = useRef({ kind, pal, warm, rot, thinking });
  latest.current = { kind, pal, warm, rot, thinking };
  useEffect(() => {
    let alive = true;
    const born = { kind, pal, warm };
    createGLMark(ref.current, born)
      .then((h) => {
        if (!alive) return h.dispose();
        handle.current = h;
        const now = latest.current;
        if (now.kind !== born.kind || now.pal !== born.pal || now.warm !== born.warm) h.setLook(now.kind, now.pal, now.warm);
        h.setRotation(now.rot);
        h.setThinking(now.thinking);
      })
      .catch((e) => setErr(String(e.message ?? e)));
    return () => {
      alive = false;
      handle.current?.dispose();
      handle.current = null;
    };
    // biome-ignore lint: created once per canvas
  }, []);
  useEffect(() => {
    handle.current?.setLook(kind, pal, warm);
  }, [kind, pal, warm]);
  useEffect(() => {
    handle.current?.setRotation(rot);
  }, [rot]);
  useEffect(() => {
    handle.current?.setThinking(thinking);
  }, [thinking]);
  useEffect(() => {
    if (turns !== lastTurns.current) handle.current?.pulse();
    lastTurns.current = turns;
  }, [turns]);
  return (
    <div className="glm">
      <canvas ref={ref} className="glm-canvas" />
      {err && <p className="glm-err">WebGL 未加载：{err}</p>}
    </div>
  );
}

function Mark(props) {
  return props.renderer === 'gl' ? <GLMark {...props} /> : <LightMark {...props} />;
}

/* ── Page ─────────────────────────────────────────────── */
function Seg({ value, options, onPick }) {
  return (
    <div className="mk-seg">
      {options.map(([v, label]) => (
        <button type="button" key={v} aria-pressed={value === v} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function useCssPalette(pal) {
  useEffect(() => {
    const r = document.documentElement.style;
    for (const [k, v] of Object.entries(pal)) r.setProperty(`--m-${k}`, v);
  }, [pal]);
}

function Gallery({ renderer, theme, selected, onSelect }) {
  const [hover, setHover] = useState(null);
  return (
    <div className="mk-gallery">
      {Object.entries(FORMS).map(([kind, f]) => {
        const pal = PALETTES[f.palette][theme];
        const rot = hover === kind ? { x: -8, y: 70, z: 0 } : { x: -18, y: 28, z: 0 };
        return (
          <button
            type="button"
            key={kind}
            className={`mk-card ${selected === kind ? 'is-selected' : ''}`}
            onClick={() => onSelect(kind)}
            onPointerEnter={() => setHover(kind)}
            onPointerLeave={() => setHover(null)}
            style={Object.fromEntries(Object.entries(pal).map(([k, v]) => [`--m-${k}`, v]))}
          >
            <div className="mk-card-stage">
              <Mark kind={kind} renderer={renderer} rot={rot} thinking={false} turns={0} pal={pal} warm={f.palette === 'warm'} />
            </div>
            <span className="mk-card-name">{f.name}</span>
            <span className="mk-card-note">{f.note}</span>
            <span className="mk-card-pal">建议基调：{f.palette === 'warm' ? '暖纸 + 珊瑚' : '冷静中性灰 + 靛蓝'}</span>
          </button>
        );
      })}
    </div>
  );
}

function Stage({ kind, renderer, pal, warm }) {
  const [page, setPage] = useState('home');
  const [thinking, setThinking] = useState(false);
  const [turns, setTurns] = useState(0);
  const [toast, setToast] = useState(null);
  const [box, setBox] = useState(null);
  const stageRef = useRef(null);
  const slots = useRef({});
  const p = PAGES[page];

  useLayoutEffect(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    const slot = slots.current[p.slot]?.getBoundingClientRect();
    if (!stage || !slot) return;
    setBox({ x: slot.left - stage.left + (slot.width - p.size) / 2, y: slot.top - stage.top + (slot.height - p.size) / 2, s: p.size / BASE });
  }, [page, p.slot, p.size]);

  useEffect(() => {
    if (page === 'home' || page === 'library') setThinking(false);
  }, [page]);

  const capture = (e) => {
    e.preventDefault();
    const input = e.currentTarget.querySelector('input');
    if (!input.value.trim()) return;
    input.value = '';
    setTurns((t) => t + 1);
    setToast('已收进来 · 稍后整理');
    window.setTimeout(() => setToast(null), 2200);
  };

  const slot = (name, cls) => <span ref={(el) => (slots.current[name] = el)} className={`mk-slot mk-slot-${name} ${cls ?? ''}`} />;

  return (
    <section className="mk-stage-wrap">
      <div className="mk-stage-head">
        <Seg value={page} options={Object.entries(PAGES).map(([k, v]) => [k, v.label])} onPick={setPage} />
        {(page === 'question' || page === 'note') && (
          <button type="button" className={`mk-think ${thinking ? 'is-on' : ''}`} onClick={() => setThinking((v) => !v)}>
            {thinking ? '停止：结果已生效' : '模拟 Copilot 思考'}
          </button>
        )}
      </div>
      <p className="mk-spec">{p.spec}</p>

      <div className="mk-stage" ref={stageRef}>
        <aside className="mk-side">
          <div className="mk-side-brand">
            {slot('logo')}
            <span>Loom</span>
          </div>
          {['回来时', '资料', '我的学习', 'Copilot 对话'].map((t, i) => (
            <span key={t} className={`mk-side-item ${(i === 0 && page === 'home') || (i === 1 && page !== 'home') ? 'is-active' : ''}`}>
              {t}
            </span>
          ))}
        </aside>

        <main className="mk-main">
          {page === 'home' && (
            <div className="mk-home">
              <div className="mk-home-lead">
                <p className="mk-eyebrow">10月7日 周三 · 晚上</p>
                <h2 className="mk-hello">上次你做完了椭圆题的第 (1) 问，第 (2) 问停在求面积的最大值。</h2>
                <p className="mk-sub">准备了一个短对比例子；也可以直接继续原来的作业。</p>
                <form className="mk-capture" onSubmit={capture}>
                  <input placeholder="记一下… 一句话、一张图或一段粘贴" />
                  <button type="submit">记下</button>
                </form>
              </div>
              {slot('hero', 'mk-slot-hero')}
              <div className="mk-pair">
                <div className="mk-block">
                  <b>继续你的</b>
                  <span>椭圆综合题 · 第 (2) 问</span>
                </div>
                <div className="mk-block">
                  <b>系统建议</b>
                  <span>短对比例子 · 约 12 分钟</span>
                </div>
              </div>
            </div>
          )}
          {(page === 'question' || page === 'note') && (
            <div className="mk-read">
              <article className="mk-content">
                <p className="mk-eyebrow">{page === 'question' ? '学校作业 · 圆锥曲线练习 第 2 题' : '笔记 · 椭圆中的“设而不求”'}</p>
                <h2 className="mk-title">{page === 'question' ? '椭圆综合题 · 第 (2) 问' : '为什么设 x = my + 1 更省事'}</h2>
                {Array.from({ length: page === 'question' ? 5 : 9 }, (_, i) => (
                  <span key={i} className="mk-line" style={{ width: `${[96, 88, 92, 70, 84, 90, 76, 94, 60][i]}%` }} />
                ))}
                {page === 'question' && <span className="mk-figure" />}
              </article>
              <aside className="mk-copilot">
                <header className="mk-copilot-head">
                  {slot('copilot')}
                  <span>学习伙伴</span>
                  <span className="mk-copilot-state">{thinking ? '在想…' : '在这里'}</span>
                </header>
                <div className="mk-msg mk-msg-me">{page === 'question' ? '第 5 步哪里不对？' : '这段能再举个反例吗？'}</div>
                <div className={`mk-msg ${thinking ? 'is-pending' : ''}`}>{thinking ? '正在看你的第 5 步…' : '先确认等号能不能取到：t 的范围是什么？'}</div>
              </aside>
            </div>
          )}
          {page === 'library' && (
            <div className="mk-list">
              <h2 className="mk-title">资料</h2>
              {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="mk-row">
                  <span className="mk-dot" />
                  <span className="mk-line" style={{ width: `${[52, 38, 60, 44, 56, 34, 48][i]}%` }} />
                  <span className="mk-row-meta" />
                </div>
              ))}
            </div>
          )}
        </main>

        {box && (
          <div className="mk-mark" style={{ transform: `translate(${box.x}px, ${box.y}px) scale(${box.s})` }}>
            <Mark kind={kind} renderer={renderer} rot={p.rot} thinking={thinking} turns={turns} pal={pal} warm={warm} />
          </div>
        )}
        {toast && <div className="mk-toast">{toast}</div>}
      </div>
    </section>
  );
}

function App() {
  const [kind, setKind] = useState('knot');
  const [renderer, setRenderer] = useState('light');
  const [paletteName, setPaletteName] = useState('warm');
  const [theme, setTheme] = useState('light');
  const pal = PALETTES[paletteName][theme];
  useCssPalette(pal);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const pick = (k) => {
    setKind(k);
    setPaletteName(FORMS[k].palette);
  };
  return (
    <div className="mk-app">
      <header className="mk-head">
        <div>
          <p className="mk-eyebrow">YUK-1353 · 第一步 · 标志物小样（原型，不进生产）</p>
          <h1 className="mk-h1">选一个会悄悄跟随的标志物</h1>
          <p className="mk-sub">静止时一动不动；只在换页、Copilot 思考、记下一条时转动。悬停卡片可以看它转一点。</p>
        </div>
        <div className="mk-controls">
          <label>
            渲染
            <Seg value={renderer} options={[['light', '轻量 CSS 3D'], ['gl', '真实 3D · WebGL']]} onPick={setRenderer} />
          </label>
          <label>
            基调
            <Seg value={paletteName} options={[['warm', '暖纸 + 珊瑚'], ['cool', '冷灰 + 靛蓝']]} onPick={setPaletteName} />
          </label>
          <label>
            主题
            <Seg value={theme} options={[['light', '亮'], ['dark', '暗']]} onPick={setTheme} />
          </label>
        </div>
      </header>

      <Gallery renderer={renderer} theme={theme} selected={kind} onSelect={pick} />

      <h2 className="mk-h2">
        在页面里：{FORMS[kind].name} · {renderer === 'gl' ? '真实 3D' : '轻量'} · {paletteName === 'warm' ? '暖纸 + 珊瑚' : '冷灰 + 靛蓝'}
      </h2>
      <Stage key={`${renderer}`} kind={kind} renderer={renderer} pal={pal} warm={paletteName === 'warm'} />
      {reduceMotion() && <p className="mk-sub">系统已开启“减少动态效果”：标志物直接切换到目标状态，不做转动。</p>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
