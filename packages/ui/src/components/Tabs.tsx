import type { ReactNode } from 'react';
import { Tabs as T, ToggleGroup as G } from 'radix-ui';
import { cx } from '../cx';
import s from './Tabs.module.css';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** Small count shown after the label (e.g. unresolved comments). */
  count?: number;
}

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: TabItem[];
  children?: ReactNode;
  className?: string;
}

/** Underlined tabs for panes (inspector: Summary · Files · PR). Render <TabPanel>s as children. */
export function Tabs({ value, onValueChange, items, children, className }: TabsProps) {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={cx(s.root, className)}>
      <T.List className={s.list}>
        {items.map((it) => (
          <T.Trigger key={it.value} value={it.value} className={s.tab}>
            {it.label}
            {it.count != null && <span className={s.count}>{it.count}</span>}
          </T.Trigger>
        ))}
      </T.List>
      {children}
    </T.Root>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <T.Content value={value} className={cx(s.panel, className)}>
      {children}
    </T.Content>
  );
}

export interface SegmentedProps {
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: ReactNode; icon?: ReactNode }[];
  label: string;
  size?: 'sm' | 'md';
}

/** Compact exclusive switch for views (Board ⇄ Plan, Chat ⇄ Terminal, Split ⇄ Unified). */
export function Segmented({ value, onValueChange, items, label, size = 'md' }: SegmentedProps) {
  return (
    <G.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v)}
      aria-label={label}
      className={cx(s.segmented, s[size])}
    >
      {items.map((it) => (
        <G.Item key={it.value} value={it.value} className={s.segment}>
          {it.icon}
          {it.label}
        </G.Item>
      ))}
    </G.Root>
  );
}
