import { denseDemoEvents } from './denseDemo';
import { fixtures } from '@helix/contracts';
import { CI_REPAIR_RECORDING, DEFAULT_RECORDING } from './recordings';

export const DEMO_SCENARIOS = [
  { value: 'multi-agent', label: 'Multi-agent plan' },
  { value: 'github-ci-repair', label: 'GitHub CI loop' },
  { value: 'cross-review', label: 'Cross review' },
  { value: 'laptop', label: 'Simulated · 12-agent laptop' },
] as const;
export type BuiltInPreset = (typeof DEMO_SCENARIOS)[number]['value'];
export type DemoPreset = BuiltInPreset | 'custom';

export function demoSelection(param: string | null) {
  const example = param === 'example';
  const preset: DemoPreset =
    param === 'laptop'
      ? 'laptop'
      : param === 'cross-review'
        ? 'cross-review'
        : param === CI_REPAIR_RECORDING
          ? 'github-ci-repair'
          : param && !example && param !== 'multi-agent' && param !== DEFAULT_RECORDING
            ? 'custom'
            : 'multi-agent';
  return { preset, requestedRecording: preset === 'custom' ? param : undefined, example };
}

export function presetRecording(preset: DemoPreset) {
  return preset === 'multi-agent'
    ? DEFAULT_RECORDING
    : preset === 'github-ci-repair'
      ? CI_REPAIR_RECORDING
      : undefined;
}

export function builtInRun(preset: DemoPreset) {
  if (preset === 'laptop') return denseDemoEvents;
  return preset === 'cross-review' ? fixtures.crossReviewRun : fixtures.passwordResetRun;
}
