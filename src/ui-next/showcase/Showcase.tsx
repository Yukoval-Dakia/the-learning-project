// Showcase for the ui-next base (YUK-1354, loft language YUK-1473). Local sample data only: no
// data fetching, no real writes (I4). Mounting it on a route is the Start owner's call; this file
// only exports the view.
import {
  BookOpen,
  Command,
  Home,
  Inbox,
  Layers,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { CompanionStatus } from '../companion';
import { MascotDock, type MascotMode } from '../mascot';
import {
  Button,
  Chip,
  ChipToggle,
  Expand,
  IconButton,
  Kbd,
  RollNumber,
  Segmented,
  Toaster,
  useToaster,
} from '../primitives';
import {
  AppFrame,
  BottomSheet,
  CommandPalette,
  CompanionPanel,
  type PaletteCommand,
  type SheetSnap,
  TabBar,
  UiNextRoot,
  useScrollCondense,
} from '../shell';
import { AnswerBlocksDemo } from './AnswerBlocksDemo';
import {
  CaptureDemo,
  DemoThread,
  MascotControls,
  PracticeStage,
  revealAnchor,
  useDemoConversation,
} from './LoftDemo';
import './showcase.css';

const SAMPLE_PARAGRAPHS = [
  '求弦长、面积或中点时，两个交点的坐标往往算不干净。只要式子里用到的是两根之和与两根之积，就不必真的把交点解出来。',
  '过 x 轴上定点的直线，设成 x = my + t：不用单独讨论斜率不存在，而且纵坐标之差直接就是面积的“高”。',
  '面积写成底乘高的一半后，代入根与系数的关系，通常只剩一个参数。',
  '换元后先确认新变量的范围，再决定用均值不等式还是单调性：等号取不到时，均值不等式给出的只是一个达不到的界。',
];

export interface ShowcaseProps {
  /** Local theme override; omit to follow the app. */
  theme?: 'light' | 'dark';
}

export function Showcase({ theme }: ShowcaseProps) {
  const [mascot, setMascot] = useState<MascotMode>('auto');
  return (
    <UiNextRoot theme={theme} mascot={mascot} className="un-showcase-root">
      <ShowcaseBody mascot={mascot} onMascot={setMascot} />
    </UiNextRoot>
  );
}

function ShowcaseBody({
  mascot,
  onMascot,
}: {
  mascot: MascotMode;
  onMascot: (mode: MascotMode) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tab, setTab] = useState<'questions' | 'notes' | 'mistakes'>('questions');
  const [onlyFollowUps, setOnlyFollowUps] = useState(false);
  const [count, setCount] = useState(3);
  const [whyOpen, setWhyOpen] = useState(false);
  const [snap, setSnap] = useState<SheetSnap>('peek');
  const { toasts, push, dismiss } = useToaster();
  const scrollRef = useRef<HTMLElement | null>(null);
  const compact = useScrollCondense(scrollRef);
  const conversation = useDemoConversation();

  const openCompanion = () => {
    setCompanionOpen(true);
    setSnap((s) => (s === 'full' ? s : 'half'));
  };
  const onReveal = (anchor: string) => revealAnchor(anchor, () => setSnap('peek'));

  const commands: PaletteCommand[] = [
    {
      id: 'go-home',
      group: '前往',
      label: '示例：回到首页',
      icon: <Home size={15} />,
      run: () => {},
    },
    { id: 'go-lib', group: '前往', label: '示例：资料', icon: <Layers size={15} />, run: () => {} },
    {
      id: 'toggle-panel',
      group: '动作',
      label: companionOpen ? '收起学习伙伴' : '打开学习伙伴',
      icon: <MessageSquare size={15} />,
      hint: <Kbd>⌘J</Kbd>,
      run: () => setCompanionOpen((o) => !o),
    },
  ];

  const sidebar = (
    <nav className="un-showcase-side" aria-label="示例侧栏">
      <IconButton
        label={collapsed ? '展开侧栏' : '收起侧栏'}
        icon={<PanelLeft size={16} />}
        onClick={() => setCollapsed((c) => !c)}
      />
      <Button
        variant="ghost"
        className="un-showcase-side-item"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={15} aria-hidden="true" />
        <span className="un-showcase-side-label">搜索或跳转</span>
      </Button>
      <div className="un-showcase-side-item un-showcase-side-pocket">
        <span className="un-showcase-side-icon" data-showcase-pocket>
          <Inbox size={15} aria-hidden="true" />
        </span>
        <span className="un-showcase-side-label">收进来的</span>
        <RollNumber value={count} className="un-showcase-side-count" />
      </div>
    </nav>
  );

  const topbar = (
    <>
      <span className="un-showcase-crumb">设计系统基座 · 展示</span>
      <span className="un-showcase-spacer" />
      <Button size="sm" variant="ghost" onClick={() => setPaletteOpen(true)}>
        <Command size={14} aria-hidden="true" /> 命令面板
      </Button>
      <Button
        size="sm"
        variant={companionOpen ? 'secondary' : 'ghost'}
        aria-pressed={companionOpen}
        onClick={() => setCompanionOpen((o) => !o)}
      >
        <PanelRight size={14} aria-hidden="true" /> 学习伙伴
      </Button>
      <MascotDock />
    </>
  );

  const companionHeader = (close: () => void) => (
    <>
      <strong>学习伙伴</strong>
      <CompanionStatus thinking={conversation.thinking} />
      <span className="un-showcase-spacer" />
      <IconButton label="收起学习伙伴" icon={<PanelRight size={16} />} onClick={close} />
    </>
  );

  const companionBody = (
    <div className="un-showcase-stack">
      <Chip tone="accent">正在看：椭圆综合题 · 第 (2) 问</Chip>
      <DemoThread conversation={conversation} onReveal={onReveal} />
      <Button
        size="sm"
        onClick={() => conversation.ask('那我应该怎么写单调性？')}
        disabled={conversation.thinking}
      >
        再问一句（看回答从生成到记录）
      </Button>
    </div>
  );

  return (
    <>
      <AppFrame
        sidebar={sidebar}
        sidebarCollapsed={collapsed}
        topbar={topbar}
        scrollRef={scrollRef}
        companionOpen={companionOpen}
        companion={
          <CompanionPanel
            open={companionOpen}
            label="学习伙伴"
            header={companionHeader(() => setCompanionOpen(false))}
          >
            {companionBody}
          </CompanionPanel>
        }
        phoneChrome={
          <>
            <BottomSheet
              label="学习伙伴"
              snap={snap}
              onSnapChange={setSnap}
              bottomInset={86}
              header={companionHeader(() => setSnap('peek'))}
            >
              {companionBody}
            </BottomSheet>
            <TabBar
              label="示例导航"
              compact={compact}
              hidden={snap === 'half' || snap === 'full'}
              items={[
                {
                  id: 'home',
                  label: '首页',
                  icon: <Home size={20} />,
                  onSelect: () => {},
                  active: true,
                },
                { id: 'lib', label: '资料', icon: <BookOpen size={20} />, onSelect: () => {} },
                {
                  id: 'capture',
                  label: '记一下',
                  icon: <Plus size={18} />,
                  primary: true,
                  badge: <RollNumber value={count} />,
                  badgeLabel: `${count} 条待整理`,
                  onSelect: () => setCount((n) => n + 1),
                },
                {
                  id: 'companion',
                  label: '学习伙伴',
                  icon: <MessageSquare size={20} />,
                  onSelect: () => setSnap((s) => (s === 'half' || s === 'full' ? 'peek' : 'half')),
                },
              ]}
            />
          </>
        }
      >
        <div className="un-showcase">
          <PracticeStage conversation={conversation} openCompanion={openCompanion} />

          <section className="un-showcase-section" aria-labelledby="un-sc-answer">
            <h2 id="un-sc-answer" className="un-showcase-h">
              点选作答（示例题：断句、配对）
            </h2>
            <AnswerBlocksDemo />
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-mascot">
            <h2 id="un-sc-mascot" className="un-showcase-h">
              吉祥物
            </h2>
            <MascotControls mode={mascot} onMode={onMascot} />
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-capture">
            <h2 id="un-sc-capture" className="un-showcase-h">
              记一下（飞进“收进来的”，手机上飞进“记一下”）
            </h2>
            <CaptureDemo onLanded={() => setCount((n) => n + 1)} />
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-buttons">
            <h2 id="un-sc-buttons" className="un-showcase-h">
              按钮
            </h2>
            <div className="un-showcase-row">
              <Button variant="primary">继续</Button>
              <Button>开始</Button>
              <Button variant="ghost">稍后</Button>
              <Button variant="quiet">不用</Button>
              <Button variant="primary" disabled>
                记下
              </Button>
              <IconButton label="打开学习伙伴" icon={<MessageSquare size={16} />} />
            </div>
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-chips">
            <h2 id="un-sc-chips" className="un-showcase-h">
              芯片
            </h2>
            <div className="un-showcase-row">
              <Chip>学校作业 · 周五交</Chip>
              <Chip tone="positive">第 (1) 问 正确</Chip>
              <Chip tone="caution">第 (2) 问 待订正</Chip>
              <Chip tone="critical">写入失败</Chip>
              <ChipToggle pressed={onlyFollowUps} onPressedChange={setOnlyFollowUps}>
                有待跟进
              </ChipToggle>
            </div>
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-seg">
            <h2 id="un-sc-seg" className="un-showcase-h">
              分段与计数
            </h2>
            <div className="un-showcase-row">
              <Segmented
                label="资料分类"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'questions', label: '题目', count: 6 },
                  { value: 'notes', label: '笔记', count: 4 },
                  { value: 'mistakes', label: '错题', count: 2 },
                ]}
              />
              <span className="un-showcase-count">
                收进来的 <RollNumber value={count} />
              </span>
              <Button size="sm" onClick={() => setCount((n) => n + 1)}>
                +1
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCount((n) => Math.max(0, n - 1))}>
                −1
              </Button>
            </div>
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-expand">
            <h2 id="un-sc-expand" className="un-showcase-h">
              展开与提示条
            </h2>
            <div className="un-showcase-row">
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={whyOpen}
                aria-controls="un-sc-why"
                onClick={() => setWhyOpen((o) => !o)}
              >
                {whyOpen ? '收起' : '为什么 · 换一种'}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  push('已推迟：短对比例子', { label: '撤销', run: () => push('已恢复') })
                }
              >
                推迟一项
              </Button>
            </div>
            <Expand open={whyOpen} id="un-sc-why">
              <div className="un-showcase-why">
                <p>为什么现在：上次停在设直线这一步，今晚有时间。</p>
                <p>可以停下：两道例子都能自己选出设法时。</p>
                <div className="un-showcase-row">
                  <ChipToggle pressed={false} onPressedChange={() => {}}>
                    换成复习
                  </ChipToggle>
                  <ChipToggle pressed={false} onPressedChange={() => {}}>
                    推迟到明天
                  </ChipToggle>
                </div>
              </div>
            </Expand>
          </section>

          <section className="un-showcase-section" aria-labelledby="un-sc-reading">
            <h2 id="un-sc-reading" className="un-showcase-h">
              阅读列（开合学习伙伴时保持阅读位置）
            </h2>
            <div className="un-showcase-prose">
              {[...SAMPLE_PARAGRAPHS, ...SAMPLE_PARAGRAPHS].map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static sample text repeated on purpose
                <p key={i}>{p}</p>
              ))}
            </div>
          </section>
        </div>
      </AppFrame>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <Toaster toasts={toasts} dismiss={dismiss} />
    </>
  );
}
