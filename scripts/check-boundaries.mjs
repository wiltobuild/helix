import { cruise } from 'dependency-cruiser';
import config from '../.dependency-cruiser.mjs';

const { output } = await cruise(['packages', 'apps'], {
  ...config.options,
  ruleSet: config,
  validate: true,
  outputType: 'json',
});
const graph = JSON.parse(output);
const violations = graph.summary.violations.map(
  ({ rule, from, to }) => rule.name + ': ' + from + ' -> ' + to,
);
const workspaceRoot = (path) => path.replaceAll('\\', '/').match(/^(?:packages|apps)\/[^/]+/)?.[0];

// Resolved graph paths enforce direction; original specifiers enforce entry points.
// This also catches imports of another package's index through a relative path.
for (const source of graph.modules) {
  const sourceRoot = workspaceRoot(source.source);
  if (!sourceRoot) continue;
  for (const dependency of source.dependencies) {
    const targetRoot = workspaceRoot(dependency.resolved);
    const specifier = dependency.module;
    const helixImport = specifier.startsWith('@helix/');
    const crossesRoot = targetRoot && targetRoot !== sourceRoot;
    // Style entry points declared in a package's exports (e.g. @helix/ui/styles.css) are allowed.
    const entryPoint =
      /^@helix\/[^/]+$/.test(specifier) || /^@helix\/[^/]+\/[\w.-]+\.css$/.test(specifier);
    if ((helixImport || crossesRoot) && !entryPoint) {
      violations.push('workspace-entry-points-only: ' + source.source + ' -> ' + specifier);
    }
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries passed (' + graph.modules.length + ' modules).');
}
