import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { fixtures, projectBuilds, projectUpTo } from '@helix/contracts';
import { BuildStages } from './BuildStages';

test('stage summary names actual facts without implying a completed build', () => {
  const build = projectBuilds(projectUpTo(fixtures.passwordResetRun, 6))[0]!;
  const html = renderToStaticMarkup(<BuildStages build={build} />);
  expect(html).toContain('Build stages');
  expect(html).toContain('Planning: approved');
  expect(html).toContain('Implementation: 0/3 tasks started');
  expect(html).not.toContain('Design:');
  expect(html).not.toContain('Build complete');
});
