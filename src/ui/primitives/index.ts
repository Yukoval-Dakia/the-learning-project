// Loom design-system primitives barrel — re-exports the loom set ONLY.
// Deliberately does NOT re-export the legacy primitives (Button / Badge / Card /
// Icon / PageHeader / TopNav / TabBar / …) which remain imported by path from
// ~40 not-yet-redrawn surfaces. New loom surfaces import from here; legacy
// surfaces keep importing legacy by path until each is retired per-slice.

export type { BrandMarkProps } from './BrandMark';
export { BrandMark } from './BrandMark';
export type { BtnProps, BtnSize, BtnVariant } from './Btn';
export { Btn } from './Btn';
export type { EmptyStateProps } from './EmptyState';
export { EmptyState } from './EmptyState';
export type { ErrorStateProps } from './ErrorState';
export { ErrorState } from './ErrorState';
export type { IconBtnProps } from './IconBtn';
export { IconBtn } from './IconBtn';
export type { LoomBadgeProps, LoomBadgeTone } from './LoomBadge';
export { LoomBadge } from './LoomBadge';
export type { LoomCardProps } from './LoomCard';
export { LoomCard } from './LoomCard';
export type { LoomIconName, LoomIconProps } from './LoomIcon';
export { LoomIcon } from './LoomIcon';
export type { RingProps } from './Ring';
export { Ring } from './Ring';
export type { SectionLabelProps } from './SectionLabel';
export { SectionLabel } from './SectionLabel';
export type { SkLinesProps } from './SkLines';
export { SkLines } from './SkLines';
export type { StatefulProps, StatefulStatus } from './Stateful';
export { Stateful } from './Stateful';
export type { UseCountUpOptions } from './useCountUp';
export { useCountUp } from './useCountUp';
export { useFocusTrap } from './useFocusTrap';
