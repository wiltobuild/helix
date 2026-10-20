import type { ReactElement, ReactNode } from 'react';
import { Tooltip as T } from 'radix-ui';
import { Kbd } from './Kbd';
import s from './Overlay.module.css';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </T.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement;
}

export function Tooltip({ content, shortcut, side = 'top', children }: TooltipProps) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content className={s.tooltip} side={side} sideOffset={6} collisionPadding={8}>
          {content}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
