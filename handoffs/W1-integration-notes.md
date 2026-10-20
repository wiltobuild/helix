# Wave 1 integration notes (Claude)

- core: startup reload uses projectUpTo(..., { strict: true }); one malformed stored event would stop the daemon. Load leniently, log anomalies, surface them via an explain.note or health.
- core: per-event applyEvent clones whole ProjectState; fine for MVP, revisit if long sessions get slow.
- core: resume tokens / delivery receipts / message modes are stored via IdempotencyStore records (workaround). Wave 2: add a small key-value seam to HelixStore (CONTRACT-REQUEST from core + storage).
- storage: recording ids + lookup not in contracts (CONTRACT-REQUEST).
- daemon: Host/Origin rejection returns 400 INVALID_REQUEST; should be 403 FORBIDDEN.
- daemon: main.ts uses a temporary createHelixCore({dataDir}) augmentation; real wiring = compose storage+git+pty+harness+scm into core's CoreDeps (Claude at integration).
