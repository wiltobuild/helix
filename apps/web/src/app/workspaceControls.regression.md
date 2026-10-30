# Laptop workspace control interaction regressions

Use an isolated demo at 1366×768 and 1440×900. Never use a running user session.
These are browser interaction checks in addition to the automated structural guards.

1. On Plan, Design, Board, Files, Commits and each navigation page (Overview,
   Tasks, Agents, Pull requests, CI, Knowledge), Show activity must reveal the
   same Dock without changing the current view. Hide activity and its height
   control must remain reachable. Toggle Active/Elapsed, pause/play, step back
   and forward, and verify the selected replay event survives view navigation.
2. On Plan, enter Focus graph. Open search with Ctrl/Cmd+K, select Board view.
   The visible Exit focus (Esc) control must remain present. Click it and verify
   the header, navigation and previously visible activity panel return. Navigate
   back to Plan; the graph selection and replay cursor must remain intact.
3. Repeat from Focus design, then search → Board → search → Plan. Exit focus
   must remain reachable throughout. Returning to Plan must not reset the cursor.
4. With focus active, open search and press Escape. Only the dialog should close;
   focus must remain active with a visible exit. Press Escape again outside editable
   fields to exit focus (if the inspector is open, the first Escape closes it).
5. Toggle activity while focused, select an agent, hide/show its inspector, then
   exit focus. Verify pre-focus panel visibility is restored and selection persists.
6. Repeat focus navigation using fullscreen where the browser permits it. Browser
   Escape/fullscreen exit must restore navigation. Otherwise verify the focus
   fallback notice and its visible Exit control. Do not claim native fullscreen
   success from a fallback-only run.

Repair validation status: new browser execution is blocked by the connected
browser timing out. These interaction cases require completion during re-review;
the automated guards verify the toolbar and activity button are unconditional
children of the workspace and graphFocus independently keeps the exit visible.
