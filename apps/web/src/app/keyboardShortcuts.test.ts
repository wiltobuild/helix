import type { KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { handlePlanShortcut, handleTaskSubmitShortcut } from './keyboardShortcuts';

function key(overrides: Partial<KeyboardEvent<HTMLElement>> = {}) {
  let stopped = false;
  const event = {
    key: 'Enter',
    ctrlKey: true,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    target: { closest: () => null },
    preventDefault(this: { defaultPrevented: boolean }) {
      this.defaultPrevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
    isPropagationStopped: () => stopped,
    ...overrides,
  } as unknown as KeyboardEvent<HTMLElement>;
  return event;
}
function actions() {
  return { enabled: true, canApprove: true, approve: vi.fn(), requestChanges: vi.fn() };
}
describe('plan and new-task shortcut interaction', () => {
  it.each(['ctrlKey', 'metaKey'] as const)(
    '%s+Enter submits a task without approving a waiting plan',
    (modifier) => {
      const event = key({ ctrlKey: false, [modifier]: true });
      const submit = vi.fn();
      const plan = actions();
      handleTaskSubmitShortcut(event, submit);
      // Even if an outer handler receives a consumed event, it must not approve another action.
      handlePlanShortcut(event, plan);
      expect(submit).toHaveBeenCalledOnce();
      expect(event.isPropagationStopped()).toBe(true);
      expect(plan.approve).not.toHaveBeenCalled();
    },
  );
  it('approves only an enabled, focused Inspector action', () => {
    const plan = actions();
    handlePlanShortcut(key(), plan);
    expect(plan.approve).toHaveBeenCalledOnce();
    handlePlanShortcut(key(), { ...plan, enabled: false });
    handlePlanShortcut(key(), { ...plan, canApprove: false });
    handlePlanShortcut(key({ repeat: true }), plan);
    handlePlanShortcut(key({ defaultPrevented: true }), plan);
    expect(plan.approve).toHaveBeenCalledOnce();
  });
  it.each(['Enter', 'r'])('ignores %s from editable fields or dialogs', (pressed) => {
    const plan = actions();
    const event = key({ key: pressed, target: { closest: () => ({}) } as unknown as EventTarget });
    handlePlanShortcut(event, plan);
    expect(plan.approve).not.toHaveBeenCalled();
    expect(plan.requestChanges).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
  it('opens request changes from Inspector focus', () => {
    const plan = actions();
    handlePlanShortcut(key({ key: 'r' }), plan);
    expect(plan.requestChanges).toHaveBeenCalledOnce();
    expect(plan.approve).not.toHaveBeenCalled();
  });
  it('consumes repeated submit keys without resubmitting', () => {
    const submit = vi.fn();
    const event = key({ repeat: true });
    handleTaskSubmitShortcut(event, submit);
    expect(submit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});
