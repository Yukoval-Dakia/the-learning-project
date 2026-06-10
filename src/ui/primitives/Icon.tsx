// Icon — lucide-react wrapper matching loom-design-v2 icon names
// Designer README: "closest match is lucide-react"
// Maps loom icon names to lucide-react components.

import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Bot,
  Brain,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cog,
  DollarSign,
  GraduationCap,
  Hash,
  History,
  Inbox,
  Info,
  Layers,
  LayoutDashboard,
  Link,
  List,
  type LucideProps,
  Minus,
  Moon,
  Network,
  PenLine,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  User,
  X,
  Zap,
} from 'lucide-react';
import type { ComponentType } from 'react';

// Map from loom icon name → lucide component
const ICON_MAP: Record<string, ComponentType<LucideProps>> = {
  // nav
  layout: LayoutDashboard,
  inbox: Inbox,
  pen: PenLine,
  refresh: RefreshCw,
  alert: AlertTriangle,
  bookmark: Bookmark,
  list: List,
  network: Network,
  // chrome
  spark: Sparkles,
  bot: Bot,
  user: User,
  clock: Clock,
  moon: Moon,
  cog: Cog,
  // proposal / action verbs
  variant: ArrowRight, // closest: directional arrows
  note: PenLine,
  quiz: Info,
  check: Check,
  x: X,
  arrowR: ArrowRight,
  arrowL: ArrowLeft,
  send: Send,
  camera: Camera,
  upload: Upload,
  search: Search,
  chev: ChevronRight,
  plus: Plus,
  trash: Trash2,
  dollar: DollarSign,
  zap: Zap,
  hash: Hash,
  link: Link,
  info: Info,
  brain: Brain,
  // M2 练习面（YUK-316）——设计稿 pface-* 用名（docs/design/loom-refresh）。
  archive: Archive,
  checkCircle: CheckCircle2,
  mistakes: AlertTriangle,
  review: RotateCw,
  spark2: Sparkles,
  sparkle: Sparkles,
  teach: GraduationCap,
  pencil: PenLine,
  close: X,
  minus: Minus,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  arrow: ArrowRight,
  bolt: Zap,
  undo: Undo2,
  layers: Layers,
  history: History,
};

export type IconName = keyof typeof ICON_MAP;

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  className?: string;
}

export function Icon({ name, size = 18, color, className }: IconProps) {
  const Component = ICON_MAP[name];
  if (!Component) return null;
  return (
    <Component
      size={size}
      color={color ?? 'currentColor'}
      strokeWidth={1.75}
      className={className}
      aria-hidden="true"
    />
  );
}
