// Loom design-system primitives barrel — re-exports the loom set ONLY.
// Deliberately does NOT re-export the legacy primitives (Button / Badge / Card /
// Icon / PageHeader / TopNav / TabBar / …) which remain imported by path from
// ~40 not-yet-redrawn surfaces. New loom surfaces import from here; legacy
// surfaces keep importing legacy by path until each is retired per-slice.

export { BrandMark } from './BrandMark';
export type { BrandMarkProps } from './BrandMark';
export { Btn } from './Btn';
export type { BtnProps, BtnSize, BtnVariant } from './Btn';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { ErrorState } from './ErrorState';
export type { ErrorStateProps } from './ErrorState';
export { IconBtn } from './IconBtn';
export type { IconBtnProps } from './IconBtn';
export { LoomBadge } from './LoomBadge';
export type { LoomBadgeProps, LoomBadgeTone } from './LoomBadge';
export { LoomCard } from './LoomCard';
export type { LoomCardProps } from './LoomCard';
export { LoomIcon } from './LoomIcon';
export type { LoomIconName, LoomIconProps } from './LoomIcon';
export { Ring } from './Ring';
export type { RingProps } from './Ring';
export { SectionLabel } from './SectionLabel';
export type { SectionLabelProps } from './SectionLabel';
export { SkLines } from './SkLines';
export type { SkLinesProps } from './SkLines';
export { Stateful } from './Stateful';
export type { StatefulProps, StatefulStatus } from './Stateful';
export { useCountUp } from './useCountUp';
export type { UseCountUpOptions } from './useCountUp';
export { useFocusTrap } from './useFocusTrap';
