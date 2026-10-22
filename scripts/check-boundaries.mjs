import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cruise } from 'dependency-cruiser';
import ts from 'typescript';
import config from '../.dependency-cruiser.mjs';

const slash = (path) => path.split(sep).join('/').replaceAll('\\', '/');
const testFile = /\.(?:test|spec)\./i;
const testDirectory = /^(?:test|tests|__tests__)$/i;
const ignored = new Set(['node_modules', '.git', '.turbo', 'dist', 'build', 'coverage']);

// resolveOptions is used by fixture tests to resolve workspace exports without symlinks.
// All path, syntax, export, and dependency-direction checks remain the same.
export async function checkBoundaries(resolveOptions = {}) {
  const repository = process.cwd();
  const violations = new Set();
  const workspaces = new Map();
  const files = [];
  for (const base of ['packages', 'apps']) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = `${base}/${entry.name}`;
      const manifestPath = `${root}/package.json`;
      if (!existsSync(manifestPath)) continue;
      workspaces.set(root, JSON.parse(readFileSync(manifestPath, 'utf8')));
      const walk = (directory) => {
        for (const child of readdirSync(directory, { withFileTypes: true })) {
          if (ignored.has(child.name)) continue;
          const path = `${directory}/${child.name}`;
          const inSource = path.startsWith(`${root}/src/`);
          if (
            !inSource &&
            (testFile.test(child.name) || (child.isDirectory() && testDirectory.test(child.name)))
          ) {
            violations.add(`tests-must-be-under-src: ${path}`);
          }
          if (child.isDirectory()) walk(path);
          else if (child.isFile() && /\.[cm]?[jt]sx?$/.test(child.name)) files.push(path);
        }
      };
      walk(root);
    }
  }

  const workspaceRoot = (path) => slash(path).match(/^(?:packages|apps)\/[^/]+/)?.[0];
  const canonicalRoots = new Map([...workspaces.keys()].map((root) => [root.toLowerCase(), root]));
  const checkCasing = (source, target) => {
    const candidate = slash(target).match(/^(?:packages|apps)\/[^/]+/i)?.[0];
    if (!candidate) return;
    const canonical = canonicalRoots.get(candidate.toLowerCase());
    if ((canonical && candidate !== canonical) || !/^(packages|apps)\//.test(candidate)) {
      violations.add(`non-canonical-workspace-path: ${source} -> ${target}`);
    }
  };
  const checkSpecifier = (source, specifier, resolved) => {
    const sourceRoot = workspaceRoot(source);
    if (!sourceRoot || !workspaces.has(sourceRoot)) return;
    if (specifier.startsWith('.') || isAbsolute(specifier)) {
      const target = slash(relative(repository, resolve(dirname(source), specifier)));
      checkCasing(source, target);
      if (!target.startsWith(`${sourceRoot}/`)) {
        violations.add(`workspace-relative-import-escape: ${source} -> ${specifier}`);
      }
    }
    if (resolved) {
      checkCasing(source, resolved);
      // Also catch aliases and symlinks resolving to first-party bridge modules.
      const firstParty = !resolved.split('/').includes('node_modules') && existsSync(resolved);
      if (
        firstParty &&
        !resolved.startsWith(`${sourceRoot}/`) &&
        !specifier.startsWith('@helix/')
      ) {
        violations.add(`workspace-entry-points-only: ${source} -> ${specifier}`);
      }
    }
    if (specifier.startsWith('@helix/')) {
      if (/^@helix\/[^/]+$/.test(specifier)) return;
      const css = specifier.match(/^(@helix\/[^/]+)\/([\w.-]+\.css)$/);
      const targetManifest = css && [...workspaces.values()].find(({ name }) => name === css[1]);
      if (targetManifest?.exports?.[`./${css[2]}`]) return;
      violations.add(`workspace-entry-points-only: ${source} -> ${specifier}`);
    }
  };

  for (const path of files) {
    if (!path.startsWith(`${workspaceRoot(path)}/src/`)) continue;
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const hasDynamicException = (node) => {
      let statement = node;
      while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
      const comments = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [];
      const statementLine = source.getLineAndCharacterOfPosition(statement.getStart(source)).line;
      return comments.some((comment) => {
        const commentLine = source.getLineAndCharacterOfPosition(comment.end).line;
        return (
          commentLine === statementLine - 1 &&
          /^\/\/\s*helix-boundaries-allow-dynamic-import:\s*\S[^\r\n]*$/.test(
            text.slice(comment.pos, comment.end),
          )
        );
      });
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (
          argument &&
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          checkSpecifier(path, argument.text);
        } else if (!hasDynamicException(node)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.add(
            `computed-dynamic-import: ${path}:${line} (use a literal or a documented exception)`,
          );
        }
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        checkSpecifier(path, node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const { output } = await cruise(
    [...workspaces.keys()],
    {
      ...config.options,
      ruleSet: config,
      validate: true,
      outputType: 'json',
    },
    resolveOptions,
  );
  const graph = JSON.parse(output);
  for (const { rule, from, to } of graph.summary.violations) {
    violations.add(`${rule.name}: ${from} -> ${to}`);
  }
  for (const source of graph.modules) {
    for (const dependency of source.dependencies) {
      checkSpecifier(slash(source.source), dependency.module, slash(dependency.resolved));
    }
  }
  return { violations: [...violations], moduleCount: graph.modules.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { violations, moduleCount } = await checkBoundaries();
  if (violations.length) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Architecture boundaries passed (${moduleCount} modules).`);
  }
}
