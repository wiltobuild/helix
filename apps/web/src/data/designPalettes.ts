import type { VisualPalette } from '@helix/contracts';

export const designPalettes: readonly VisualPalette[] = [
  {
    name: 'Teal & rust',
    background: '#F6F4EF',
    foreground: '#183430',
    primary: '#0E7672',
    accent: '#B64D31',
  },
  {
    name: 'Midnight studio',
    background: '#141B2D',
    foreground: '#F2F1F8',
    primary: '#B9B0FF',
    accent: '#FFC595',
  },
  {
    name: 'Botanical',
    background: '#F0F3E8',
    foreground: '#243F2E',
    primary: '#346247',
    accent: '#A8472E',
  },
  {
    name: 'Cobalt editorial',
    background: '#F5F4F0',
    foreground: '#1E2543',
    primary: '#304EC5',
    accent: '#9B3C62',
  },
];

export function samePalette(a?: VisualPalette | null, b?: VisualPalette | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
