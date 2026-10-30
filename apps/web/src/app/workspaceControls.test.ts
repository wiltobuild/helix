import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

// These structural guards cover the reachability bugs independently of demo data:
// the toolbar must not disappear with a page/tab branch or the hidden header.
const source = ts.createSourceFile(
  'App.tsx',
  readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const elements: ts.JsxElement[] = [];
function visit(node: ts.Node) {
  if (ts.isJsxElement(node)) elements.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
const toolbar = elements.find((element) =>
  element.openingElement.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText(source) === 'aria-label' &&
      attribute.initializer &&
      ts.isStringLiteral(attribute.initializer) &&
      attribute.initializer.text === 'Workspace display controls',
  ),
)!;

test('activity controls are unconditional siblings of page content and the Dock', () => {
  expect(toolbar).toBeDefined();
  expect(ts.isJsxElement(toolbar.parent)).toBe(true);
  expect(ts.isJsxElement(toolbar.parent.parent)).toBe(true);
  expect((toolbar.parent.parent as ts.JsxElement).openingElement.tagName.getText(source)).toBe(
    'main',
  );
  const activity = elements.find(
    (element) =>
      element.openingElement.tagName.getText(source) === 'Button' &&
      element.openingElement.attributes.getText(source).includes('setActivityHidden'),
  );
  expect(activity?.parent).toBe(toolbar);
});

test('session tabs share the controls row without becoming action-group children', () => {
  const row = toolbar.parent as ts.JsxElement;
  expect(
    row.children.some(
      (child) => ts.isJsxExpression(child) && child.getText(source).includes('<SessionTabs'),
    ),
  ).toBe(true);
  expect(toolbar.getText(source)).not.toContain('<SessionTabs');
  const header = source.getText().match(/<SessionHeader[\s\S]*?\/>/);
  expect(header?.[0]).toContain('hideTabs');
});

test('focus exit remains reachable regardless of the current page or tab', () => {
  const focus = elements.find((element) =>
    element.openingElement.attributes.getText(source).includes('ref={focusButton}'),
  )!;
  expect(focus).toBeDefined();
  const branch = focus.parent.parent.parent;
  expect(ts.isBinaryExpression(branch)).toBe(true);
  const condition = (branch as ts.BinaryExpression).left;
  const unwrapped = ts.isParenthesizedExpression(condition) ? condition.expression : condition;
  expect(ts.isBinaryExpression(unwrapped)).toBe(true);
  const alternatives = unwrapped as ts.BinaryExpression;
  expect(alternatives.operatorToken.kind).toBe(ts.SyntaxKind.BarBarToken);
  expect(alternatives.left.getText(source)).toBe('graphFocus');
  expect(branch.parent.parent).toBe(toolbar);
});
