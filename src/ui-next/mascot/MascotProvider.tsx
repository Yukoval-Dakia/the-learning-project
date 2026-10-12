// How pages talk to the one mascot (B1–B3):
//
//   <MascotSlot size={MASCOT_SIZE.read} phoneSize={MASCOT_SIZE.readPhone} rest={{ y: -12 }} />
//     declares where the mascot sits on this page (a banner corner). It springs there.
//   <MascotDock />
//     the phone top-bar spot it tucks into once the slot scrolls under the bar.
//   useMascotActivity({ thinking, settleKey })
//     the companion's run state: spins while `thinking`, turns one petal when `settleKey` changes.
//   useMascot().advance()
//     a one-off "received" (e.g. something captured).
//
// The provider is mounted by <UiNextRoot>; the layer appears once the first slot does.
import type { CSSProperties, ReactNode } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type MascotController, createMascotController } from './controller';
import { MascotLayer, type MascotMode } from './MascotLayer';
import { type Orientation, restOf } from './orientation';

const MascotContext = createContext<MascotController | null>(null);

export interface MascotProviderProps {
  /** `auto`: glass flower where the device can afford it; `still`: always the still flower. */
  mode?: MascotMode;
  children?: ReactNode;
}

export function MascotProvider({ mode = 'auto', children }: MascotProviderProps) {
  const [controller] = useState(createMascotController);
  return (
    <MascotContext.Provider value={controller}>
      {children}
      {mode !== 'off' && <MascotLayer controller={controller} mode={mode} />}
    </MascotContext.Provider>
  );
}

export interface MascotSlotProps {
  /** Width in px on desktop (B1; see MASCOT_SIZE). */
  size: number;
  /** Width in px at phone width; defaults to `size`. */
  phoneSize?: number;
  /** Resting orientation in degrees; clamped to the B2 limits. */
  rest?: Partial<Orientation>;
  /** A faint accent halo behind the flower, in percent of the accent (0 = none). */
  glow?: number;
  className?: string;
}

/** Where the mascot sits on this page. Declare one per page, in the banner. */
export function MascotSlot({ size, phoneSize, rest, glow = 0, className }: MascotSlotProps) {
  const controller = useContext(MascotContext);
  const ref = useRef<HTMLSpanElement>(null);
  const { x, y, z } = restOf(rest);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!controller || !el) return;
    return controller.addSlot({ el, rest: { x, y, z } });
  }, [controller, x, y, z]);
  const style = {
    '--un-slot': `${size}px`,
    '--un-slot-phone': `${phoneSize ?? size}px`,
    '--un-slot-glow': `${glow}%`,
  } as CSSProperties;
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={['un-mascot-slot', className].filter(Boolean).join(' ')}
      style={style}
    />
  );
}

/** The phone top-bar spot (B3). Put it at the end of the top bar; it is hidden on desktop. */
export function MascotDock() {
  const controller = useContext(MascotContext);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!controller || !el) return;
    return controller.addDock(el);
  }, [controller]);
  return <span ref={ref} aria-hidden="true" className="un-mascot-dock" />;
}

export interface MascotActivity {
  /** The companion is working on an answer: the flower spins like a pinwheel (B2, C3). */
  thinking?: boolean;
  /**
   * Changes whenever something is recorded (e.g. the id or count of settled answers): the flower
   * turns one petal forward. The first value is the baseline and does not turn it.
   */
  settleKey?: string | number;
}

/**
 * Drive the mascot from run state. Several components may use it at once; the flower thinks
 * while any of them is thinking. The words on screen ("在想…") stay the source of truth (B4).
 */
export function useMascotActivity({ thinking = false, settleKey }: MascotActivity): void {
  const controller = useContext(MascotContext);
  const [source] = useState(() => Symbol('mascot-activity'));
  useEffect(() => {
    controller?.setThinking(source, thinking);
  }, [controller, source, thinking]);
  useEffect(() => () => controller?.setThinking(source, false), [controller, source]);
  const baseline = useRef(settleKey);
  useEffect(() => {
    if (settleKey === undefined || settleKey === baseline.current) return;
    baseline.current = settleKey;
    controller?.advance();
  }, [controller, settleKey]);
}

/** Imperative access for one-off moments. A no-op outside <UiNextRoot>. */
export function useMascot(): { advance: () => void; relayout: () => void } {
  const controller = useContext(MascotContext);
  return useMemo(
    () => ({
      advance: () => controller?.advance(),
      relayout: () => controller?.relayout(),
    }),
    [controller],
  );
}
