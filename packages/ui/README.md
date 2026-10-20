# @helix/ui

Helix design system: tokens (`src/styles/tokens.css`), base styles, and React components built on Radix primitives and CSS Modules.

Owned by Claude (UI). Codex agents: do not edit.

- Import styles once at the app root: `import '@helix/ui/styles.css'`.
- Colors, type, spacing and motion come only from tokens; no literal colors in components.
- Status is shown as icon + label (never color alone) via `StatusPill` / `StatusDot`.
- The two agent strands: teal = Claude Code, coral = Codex (`AgentBadge`).
