import { useId } from 'react';

// The glass pinwheel flower as a still image (B4 fallback). The outline is the same rim the
// WebGL model sweeps (flower-gl.ts `petalGeometry`): six rounded trapezoids, corners at
// 0° / 19° / 54° of each 60° turn on radii 0.87 / 1.37, rounded at 22%, seen face-on with the
// hub hole of radius 0.22. Each soft ridge follows the model's sweep from the hub out to the
// broad edge. Inline SVG, so it needs no image request and nothing outside the app's origin (CSP).
const OUTLINE =
  'M0.978 0.032Q0.870 -0.000 0.964 -0.098L1.202 -0.348Q1.295 -0.446 1.188 -0.592L0.913 -0.963Q0.805 -1.108 0.724 -1.030L0.516 -0.832Q0.435 -0.753 0.397 -0.884L0.300 -1.215Q0.261 -1.345 0.081 -1.324L-0.377 -1.272Q-0.557 -1.252 -0.530 -1.142L-0.462 -0.863Q-0.435 -0.753 -0.567 -0.785L-0.902 -0.867Q-1.034 -0.899 -1.106 -0.733L-1.290 -0.309Q-1.362 -0.143 -1.254 -0.112L-0.978 -0.032Q-0.870 -0.000 -0.964 0.098L-1.202 0.348Q-1.295 0.446 -1.188 0.592L-0.913 0.963Q-0.805 1.108 -0.724 1.030L-0.516 0.832Q-0.435 0.753 -0.397 0.884L-0.300 1.215Q-0.261 1.345 -0.081 1.324L0.377 1.272Q0.557 1.252 0.530 1.142L0.462 0.863Q0.435 0.753 0.567 0.785L0.902 0.867Q1.034 0.899 1.106 0.733L1.290 0.309Q1.362 0.143 1.254 0.112L0.978 0.032Z';
const HUB = 'M0.22 0A0.22 0.22 0 1 0 -0.22 0A0.22 0.22 0 1 0 0.22 0Z';
const CREASES =
  'M0.289 -0.082Q0.707 -0.330 0.992 -0.675M0.073 -0.291Q0.067 -0.777 -0.088 -1.197M-0.215 -0.209Q-0.639 -0.447 -1.080 -0.522M-0.289 0.082Q-0.707 0.330 -0.992 0.675M-0.073 0.291Q-0.067 0.777 0.088 1.197M0.215 0.209Q0.639 0.447 1.080 0.522';

export function FlowerStill({ className }: { className?: string }) {
  // Ids must be unique per document and safe inside url(#…).
  const id = `un-flower-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const shape = `${OUTLINE}${HUB}`;
  return (
    <svg className={className} viewBox="-1.5 -1.5 3 3" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient
          id={`${id}-body`}
          x1="-1.1"
          y1="-1.2"
          x2="1.1"
          y2="1.3"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#ebe7e1" />
          <stop offset="1" stopColor="#bdb7af" />
        </linearGradient>
        <radialGradient id={`${id}-depth`} cx="0" cy="0" r="1.4" gradientUnits="userSpaceOnUse">
          <stop offset="0.14" stopColor="#5f554b" stopOpacity="0.38" />
          <stop offset="0.5" stopColor="#5f554b" stopOpacity="0.08" />
          <stop offset="1" stopColor="#5f554b" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={`${id}-tint`}
          cx="0.35"
          cy="0.55"
          r="1.2"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" style={{ stopColor: 'var(--un-accent)' }} stopOpacity="0.14" />
          <stop offset="1" style={{ stopColor: 'var(--un-accent)' }} stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-soft`} x="-0.2" y="-0.2" width="1.4" height="1.4">
          <feGaussianBlur stdDeviation="0.045" />
        </filter>
        <clipPath id={`${id}-clip`}>
          <path d={shape} clipRule="evenodd" />
        </clipPath>
      </defs>
      {/* Body: a rounded join softens the notches the way the glass tube does in 3D. */}
      <path
        d={shape}
        fillRule="evenodd"
        fill={`url(#${id}-body)`}
        stroke={`url(#${id}-body)`}
        strokeWidth="0.1"
        strokeLinejoin="round"
      />
      <g
        clipPath={`url(#${id}-clip)`}
        fill="none"
        strokeLinecap="round"
        filter={`url(#${id}-soft)`}
      >
        <path d={shape} fillRule="evenodd" fill={`url(#${id}-depth)`} />
        <path
          d={CREASES}
          stroke="#5f554b"
          strokeOpacity="0.32"
          strokeWidth="0.16"
          transform="rotate(9)"
        />
        <path d={CREASES} stroke="#ffffff" strokeOpacity="0.95" strokeWidth="0.12" />
        <path d={OUTLINE} stroke="#ffffff" strokeWidth="0.12" transform="translate(-0.03 -0.04)" />
        <circle r="0.3" stroke="#ffffff" strokeWidth="0.1" transform="translate(-0.02 -0.03)" />
      </g>
      <path d={shape} fillRule="evenodd" fill={`url(#${id}-tint)`} />
      <g fill="none" stroke="#4f463d" strokeLinejoin="round">
        <path d={OUTLINE} strokeOpacity="0.22" strokeWidth="0.025" transform="scale(1.035)" />
        <circle r="0.2" strokeOpacity="0.35" strokeWidth="0.03" />
      </g>
    </svg>
  );
}
