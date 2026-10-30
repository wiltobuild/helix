import type { ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import s from './Overlay.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** Wider dialog for rich content (e.g. the Why chain). */
  wide?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  wide,
}: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className={s.dialogOverlay} />
        <D.Content className={wide ? `${s.dialog} ${s.dialogWide}` : s.dialog}>
          <div className={s.dialogHeader}>
            <D.Title className={s.dialogTitle}>{title}</D.Title>
            {description ? (
              <D.Description className={s.dialogDescription}>{description}</D.Description>
            ) : (
              <D.Description hidden>{title}</D.Description>
            )}
          </div>
          {children}
          {footer && <div className={s.dialogFooter}>{footer}</div>}
          <D.Close asChild>
            <IconButton className={s.dialogClose} label="Close" icon={<X size={16} />} size="sm" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
