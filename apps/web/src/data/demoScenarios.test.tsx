import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures } from '@helix/contracts';
import { TooltipProvider } from '@helix/ui';
import { TopBar } from '../app/Chrome';
import { builtInRun, demoSelection, presetRecording } from './demoScenarios';
import { replayStart } from './recordings';
import type { HelixSource } from './useHelixSource';

test('the cross-review URL selects the built-in fixture without a recording fetch', () => {
  const selection = demoSelection(new URLSearchParams('?demo=cross-review').get('demo'));
  expect(selection.preset).toBe('cross-review');
  expect(selection.requestedRecording).toBeUndefined();
  expect(presetRecording(selection.preset)).toBeUndefined();
  expect(builtInRun(selection.preset)).toBe(fixtures.crossReviewRun);
  expect(replayStart(builtInRun(selection.preset))).toBe(2);
});

test.each([
  [null, 'multi-agent', 'discount-codes'],
  ['', 'multi-agent', 'discount-codes'],
  ['multi-agent', 'multi-agent', 'discount-codes'],
  ['discount-codes', 'multi-agent', 'discount-codes'],
  ['github-ci-repair', 'github-ci-repair', 'github-ci-repair'],
] as const)('existing demo URL %s keeps its recording', (param, preset, recording) => {
  const selection = demoSelection(param);
  expect(selection.preset).toBe(preset);
  expect(presetRecording(selection.preset)).toBe(recording);
  expect(builtInRun(selection.preset)).toBe(fixtures.passwordResetRun);
});

test('example and custom recordings keep their URL meanings', () => {
  expect(demoSelection('example')).toMatchObject({ preset: 'multi-agent', example: true });
  expect(demoSelection('my-run')).toMatchObject({ preset: 'custom', requestedRecording: 'my-run' });
});

test('scenario control offers three choices and selects Cross review', () => {
  const source: HelixSource = {
    sourceId: 'demo:cross-review',
    mode: 'demo',
    events: fixtures.crossReviewRun,
    projects: [],
    stream: 'demo',
    selectProject: () => {},
    addProject: async () => {},
    openRecording: async () => {},
    speed: 1,
    setSpeed: () => {},
    staticBuild: true,
    demoPreset: 'cross-review',
    selectDemoPreset: () => {},
  };
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <TopBar
        source={source}
        working={0}
        onSearch={() => {}}
        onSettings={() => {}}
        onShortcuts={() => {}}
      />
    </TooltipProvider>,
  );
  for (const label of ['Multi-agent plan', 'GitHub CI loop', 'Cross review'])
    expect(html).toContain(label);
  expect(html).toMatch(/<button[^>]*aria-checked="true"[^>]*>Cross review<\/button>/);
});
