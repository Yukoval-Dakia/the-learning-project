// BrandMark — the loom woven-grid logo. Ported verbatim from
// docs/design/loom-prototype/components.jsx (BrandMark).

export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 30 }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Loom"
    >
      <rect
        x="10"
        y="10"
        width="44"
        height="44"
        rx="5"
        stroke="currentColor"
        strokeOpacity="0.32"
      />
      <path d="M10 22 C 22 22, 22 30, 32 30 S 42 22, 54 22" />
      <path d="M10 32 C 22 32, 22 40, 32 40 S 42 32, 54 32" strokeOpacity="0.72" />
      <path d="M10 42 C 22 42, 22 50, 32 50 S 42 42, 54 42" strokeOpacity="0.46" />
    </svg>
  );
}
