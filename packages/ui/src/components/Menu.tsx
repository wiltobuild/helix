import type { ReactElement, ReactNode } from 'react';
import { DropdownMenu as M } from 'radix-ui';
import s from './Overlay.module.css';

export interface MenuProps {
  trigger: ReactElement;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}

export function Menu({ trigger, children, align = 'end' }: MenuProps) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content className={s.menu} align={align} sideOffset={6} collisionPadding={8}>
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export interface MenuItemProps {
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}

export function MenuItem({ icon, shortcut, danger, disabled, onSelect, children }: MenuItemProps) {
  return (
    <M.Item
      className={s.menuItem}
      data-danger={danger || undefined}
      disabled={disabled}
      onSelect={onSelect}
    >
      {icon}
      <span>{children}</span>
      {shortcut && <span className={s.menuShortcut}>{shortcut}</span>}
    </M.Item>
  );
}

export const MenuSeparator = () => <M.Separator className={s.menuSeparator} />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <M.Label className={s.menuLabel}>{children}</M.Label>
);
