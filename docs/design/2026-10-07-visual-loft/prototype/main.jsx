import 'katex/dist/katex.min.css';
import './tokens.css';
import './base.css';
import './variant-a.css';
import './variant-b.css';
import './variant-c.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LoftProvider, useLoft } from './store.jsx';
import { CommandPalette, Toasts, useCommands, useProductShortcuts } from './shared.jsx';
import * as A from './variant-a.jsx';
import * as B from './variant-b.jsx';
import * as C from './variant-c.jsx';

const VARIANTS = {
  a: { mod: A, name: 'A 纸页', note: '顶栏三入口 + ⌘K（手机底栏）· 单栏叙述 · 文档与边注（宽屏题干固定）' },
  b: { mod: B, name: 'B 工作室', note: '常驻侧栏 · 两栏并列面板 · 三栏工作台' },
  c: { mod: C, name: 'C 学习线', note: '底部命令条 · 学习线分叉 · 舞台与升起面板' },
};

function Product() {
  const { params } = useLoft();
  const commands = useCommands();
  useProductShortcuts();
  const V = VARIANTS[params.v]?.mod ?? A;
  return (
    <>
      <V.Shell>{params.screen === 'work' ? <V.Workbench /> : <V.Home />}</V.Shell>
      <CommandPalette commands={commands} />
      <Toasts />
    </>
  );
}

function Seg({ value, options, onPick }) {
  return (
    <div className="loft-seg">
      {options.map(([v, label]) => (
        <button type="button" key={v} aria-pressed={value === v} onClick={() => onPick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function LoftBar() {
  const { params, setParam, failWrites, setFailWrites, prefetch } = useLoft();
  const [min, setMin] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey) return;
      const k = e.code;
      if (k === 'Digit1' || k === 'Digit2' || k === 'Digit3') setParam({ v: { Digit1: 'a', Digit2: 'b', Digit3: 'c' }[k] }, { transition: true });
      if (k === 'KeyS') setParam({ screen: params.screen === 'home' ? 'work' : 'home' }, { transition: true });
      if (k === 'KeyT') setParam({ theme: params.theme === 'dark' ? 'light' : 'dark' });
      if (k === 'KeyM') setParam({ device: params.device === 'mobile' ? 'desktop' : 'mobile' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [params, setParam]);
  if (min)
    return (
      <div className="loft-bar is-min">
        <button type="button" className="loft-mini" onClick={() => setMin(false)}>
          Loft · {VARIANTS[params.v].name}
        </button>
      </div>
    );
  return (
    <div className="loft-bar" data-loft-bar>
      <div className="loft-head">
        <strong>YUK-1353 loft</strong>
        <button type="button" className="loft-mini" onClick={() => setMin(true)}>
          收起
        </button>
      </div>
      <div className="loft-row">
        <span>变体</span>
        <Seg value={params.v} options={[['a', 'A 纸页'], ['b', 'B 工作室'], ['c', 'C 学习线']]} onPick={(v) => setParam({ v }, { transition: true })} />
      </div>
      <div className="loft-row">
        <span>屏幕</span>
        <Seg value={params.screen} options={[['home', '回来时'], ['work', '工作台']]} onPick={(screen) => setParam({ screen }, { transition: true })} />
      </div>
      <div className="loft-row">
        <span>主题</span>
        <Seg value={params.theme} options={[['light', '亮'], ['dark', '暗']]} onPick={(theme) => setParam({ theme })} />
      </div>
      <div className="loft-row">
        <span>设备</span>
        <Seg value={params.device} options={[['desktop', '桌面'], ['mobile', '手机 390']]} onPick={(device) => setParam({ device })} />
      </div>
      <div className="loft-row">
        <span>数据</span>
        <Seg
          value={params.state}
          options={[['normal', '正常'], ['absent', '久别'], ['empty', '空'], ['loading', '载入'], ['error', '出错']]}
          onPick={(state) => setParam({ state })}
        />
      </div>
      <label className="loft-row">
        <span>写入</span>
        <span>
          <input type="checkbox" checked={failWrites} onChange={(e) => setFailWrites(e.target.checked)} /> 模拟写入失败（看回滚）
        </span>
      </label>
      <p className="loft-note">{VARIANTS[params.v].note}</p>
      <p className="loft-note">
        预取：{Object.keys(prefetch).length ? Object.entries(prefetch).map(([k, how]) => `${k}（${how}）`).join('、') : '—'}
      </p>
      <p className="loft-note">Alt+1/2/3 变体 · Alt+S 屏幕 · Alt+T 主题 · Alt+M 设备 · ⌘K 命令</p>
    </div>
  );
}

function DeviceStage() {
  const { params } = useLoft();
  const q = new URLSearchParams({ ...params, device: 'desktop', chrome: '0' });
  return (
    <div className="device-stage">
      <iframe key={q.toString()} title="手机 390×844" className="device-frame" src={`?${q}`} />
    </div>
  );
}

function App() {
  const { params } = useLoft();
  return (
    <>
      {params.device === 'mobile' && params.chrome !== '0' ? <DeviceStage /> : <Product />}
      {params.chrome !== '0' && <LoftBar />}
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LoftProvider>
      <App />
    </LoftProvider>
  </StrictMode>,
);
