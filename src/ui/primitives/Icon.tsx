// Icon — lucide-react wrapper matching loom-design-v2 icon names
// Designer README: "closest match is lucide-react"
// Maps loom icon names to lucide-react components.

import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Bot,
  Brain,
  Camera,
  Check,
  ChevronRight,
  Clock,
  Cog,
  DollarSign,
  Hash,
  Inbox,
  Info,
  LayoutDashboard,
  Link,
  List,
  type LucideProps,
  Moon,
  Network,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
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
