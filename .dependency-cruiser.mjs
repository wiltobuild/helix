const allowed = {
  contracts: [],
  testing: ['contracts'],
  storage: ['contracts'],
  harness: ['contracts'],
  'pty-host': ['contracts'],
  git: ['contracts'],
  scm: ['contracts'],
  core: ['contracts', 'storage', 'harness', 'git', 'scm'],
  'api-client': ['contracts'],
  ui: ['contracts'],
  daemon: [
    'contracts',
    'testing',
    'storage',
    'core',
    'harness',
    'pty-host',
    'git',
    'scm',
    'api-client',
  ],
  cli: ['contracts', 'api-client'],
  web: ['ui', 'contracts', 'api-client'],
};
const testConsumers = new Set(['storage', 'harness', 'pty-host', 'git', 'scm', 'core']);
const tests = String.raw`(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|/)(?:test|tests|__tests__)/)`;
const root = (name) => (['daemon', 'cli', 'web'].includes(name) ? 'apps/' : 'packages/') + name;
const target = (names) =>
  '^(?:' +
  names.flatMap((name) => [root(name) + '/', '@helix/' + name + '(?:/|$)']).join('|') +
  ')';

export default {
  forbidden: [
    { name: 'no-unresolved-imports', severity: 'error', from: {}, to: { couldNotResolve: true } },
    {
      name: 'no-production-to-tests',
      severity: 'error',
      from: { pathNot: tests },
      to: { path: tests },
    },
    ...Object.entries(allowed).flatMap(([name, dependencies]) => {
      const rule = (isTest) => ({
        name: name + (isTest ? '-test-dependencies' : '-production-dependencies'),
        severity: 'error',
        from: {
          path: '^' + root(name) + '/',
          ...(isTest ? { path: '^' + root(name) + '(?=/).*' + tests } : { pathNot: tests }),
        },
        to: {
          path: '^(?:packages/|apps/|@helix/)',
          pathNot: target([
            name,
            ...dependencies,
            ...(isTest && testConsumers.has(name) ? ['testing'] : []),
          ]),
        },
      });
      return [rule(false), rule(true)];
    }),
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(?:node_modules|dist|build|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
    },
  },
};
