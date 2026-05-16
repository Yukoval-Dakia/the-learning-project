// Brand mark — 3 woven curves through a frame
// Matches loom-design-v2 primitives.jsx Brand component

export interface BrandProps {
  /** Icon size in px (default 22) */
  size?: number;
  className?: string;
}

export function BrandMark({ size = 22, className }: BrandProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="10" y="10" width="44" height="44" rx="4" strokeOpacity="0.35" />
      <path d="M10 22 C 22 22, 22 30, 32 30 S 42 22, 54 22" />
      <path d="M10 32 C 22 32, 22 40, 32 40 S 42 32, 54 32" strokeOpacity="0.7" />
      <path d="M10 42 C 22 42, 22 50, 32 50 S 42 42, 54 42" strokeOpacity="0.45" />
    </svg>
  );
}

/** Full brand lockup: monogram + wordmark */
export function Brand({ size = 22, className }: BrandProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ''}`}
      style={{ color: 'var(--coral)' }}
    >
      <BrandMark size={size} />
      <span
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--ink)',
          letterSpacing: 'var(--ls-tight)',
        }}
      >
        Loom
      </span>
    </span>
  );
}
