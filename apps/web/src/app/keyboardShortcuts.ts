import type { KeyboardEvent } from 'react';

/** Only the focused Inspector owns plan shortcuts; never consume text editing or another action. */
export function handlePlanShortcut(
  event: KeyboardEvent<HTMLElement>,
  actions: {
    enabled: boolean;
    canApprove: boolean;
    approve: () => void;
    requestChanges: () => void;
  },
) {
  if (
    !actions.enabled ||
    event.defaultPrevented ||
    event.repeat ||
    !(event.metaKey || event.ctrlKey)
  )
    return;
  const target = event.target as HTMLElement;
  if (
    target.closest?.(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="dialog"]',
    )
  )
    return;
  if (event.key === 'Enter' && actions.canApprove) {
    event.preventDefault();
    event.stopPropagation();
    actions.approve();
  } else if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    event.stopPropagation();
    actions.requestChanges();
  }
}

export function handleTaskSubmitShortcut(event: KeyboardEvent<HTMLElement>, submit: () => void) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) submit();
}
