import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Switch as Sw } from 'radix-ui';
import { cx } from '../cx';
import s from './Field.module.css';

interface FieldShellProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, id, children }: FieldShellProps) {
  return (
    <div className={s.field}>
      {label && (
        <label htmlFor={id} className={s.label}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-msg`} className={s.error} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className={s.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  icon?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, icon, id: idProp, className, ...rest },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} id={id}>
      <div className={cx(s.control, icon && s.withIcon, error && s.invalid, className)}>
        {icon && <span className={s.icon}>{icon}</span>}
        <input
          ref={ref}
          id={id}
          className={s.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-msg` : undefined}
          {...rest}
        />
      </div>
    </FieldShell>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, id: idProp, className, ...rest },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell label={label} hint={hint} error={error} id={id}>
      <textarea
        ref={ref}
        id={id}
        className={cx(s.control, s.textarea, error && s.invalid, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        {...rest}
      />
    </FieldShell>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  id?: string;
}

export function Switch({ checked, onCheckedChange, label, description, id: idProp }: SwitchProps) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <div className={s.switchRow}>
      <div className={s.switchText}>
        <label htmlFor={id} className={s.switchLabel}>
          {label}
        </label>
        {description && <p className={s.hint}>{description}</p>}
      </div>
      <Sw.Root id={id} checked={checked} onCheckedChange={onCheckedChange} className={s.switch}>
        <Sw.Thumb className={s.thumb} />
      </Sw.Root>
    </div>
  );
}
