import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cx } from '../cx';
import { Kbd } from './Kbd';
import { Tooltip } from './Tooltip';
import s from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Shortcut hint rendered at the end of the button, e.g. "⌘N". */
  shortcut?: string;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, shortcut, loading, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.button, s[variant], s[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className={s.spin} size={14} aria-hidden /> : icon}
      {children != null && <span className={s.label}>{children}</span>}
      {shortcut && <Kbd className={s.kbd}>{shortcut}</Kbd>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'shortcut'> {
  /** Required: names the action for screen readers and the tooltip. */
  label: string;
  icon: ReactNode;
  shortcut?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, variant = 'ghost', size = 'md', className, ...rest },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cx(s.button, s[variant], s[size], s.iconOnly, className)}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
