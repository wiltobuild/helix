import { describe, expect, it } from 'vitest';
import { chooseProject } from './projectSelection';

const projects = [
  { id: 'old-image-heavy', createdAt: '2026-10-29T17:05:16.244Z' },
  { id: 'new-small', createdAt: '2026-10-31T23:40:59.262Z' },
  { id: 'middle', createdAt: '2026-10-30T20:38:47.256Z' },
];

describe('initial live project selection', () => {
  it('opens the newest project instead of replaying an old image-heavy project by default', () => {
    expect(chooseProject(projects)?.id).toBe('new-small');
  });

  it('keeps a current, remembered, or newly created project ahead of the fallback', () => {
    expect(chooseProject(projects, undefined, 'middle', 'old-image-heavy')?.id).toBe('middle');
    expect(chooseProject(projects, undefined, undefined, 'old-image-heavy')?.id).toBe(
      'old-image-heavy',
    );
    expect(chooseProject(projects, 'new-small', 'middle', 'old-image-heavy')?.id).toBe('new-small');
  });

  it('falls back safely when the remembered project no longer exists', () => {
    expect(chooseProject(projects, undefined, undefined, 'deleted')?.id).toBe('new-small');
  });
});
