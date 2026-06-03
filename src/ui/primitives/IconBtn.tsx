// IconBtn — loom icon-only button. className-driven over the .icon-btn class
// layer in app/globals.css. Ported from docs/design/loom-prototype/components.jsx.

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { LoomIcon } from './LoomIcon';
import type { LoomIconName } from './LoomIcon';

export interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LoomIconName;
  size?: number;
}

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn(
  { icon, size = 18, className, ...rest },
  ref,
) {
  // Icon-only buttons must never be nameless: keep an explicit aria-label/title
  // when the caller passes one, otherwise fall back to the icon name. (Falling
  // back only when no title is set avoids overriding a human title with the
  // camelCase icon token, since aria-label wins over title for the a11y name.)
  const ariaLabel = rest['aria-label'] ?? (rest.title ? undefined : icon);
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn ${className ?? ''}`.trim()}
      {...rest}
      aria-label={ariaLabel}
    >
      <LoomIcon name={icon} size={size} />
    </button>
  );
});
