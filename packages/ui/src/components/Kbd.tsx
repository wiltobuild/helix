import type { HTMLAttributes } from 'react';
import { cx } from '../cx';
import s from './Kbd.module.css';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx(s.kbd, className)} {...rest} />;
}
