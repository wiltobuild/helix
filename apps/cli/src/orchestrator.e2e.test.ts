import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import { projectIdSchema, projectUpTo, type HelixEvent } from '@helix/contracts';
import { resolveBaseUrl, runCli } from './index.js';

test.skipIf(process.env.HELIX_E2E !== '1')(
  'real orchestrator submits a contract-first plan and waits for human approval',
  async (context) => {
    if (process.env.HELIX_ORCHESTRATOR_E2E_READY !== '1') {
      context.skip(
        'Orchestrator wiring unavailable: needs #19 HarnessStartOptions.env, helix on agent PATH, HELIX_URL/HELIX_SESSION_ID/HELIX_PROJECT_ID, and daemon orchestratorPrompt injection. Set HELIX_ORCHESTRATOR_E2E_READY=1 only after wiring these.',
      );
    }
    if (!process.env.HELIX_PROJECT_ID || !process.env.HELIX_URL) {
      context.skip(
        'Set HELIX_PROJECT_ID and HELIX_URL for an isolated registered smoke repository and daemon.',
      );
    }
    const projectId = projectIdSchema.parse(process.env.HELIX_PROJECT_ID);
    const client = createHelixClient({ baseUrl: await resolveBaseUrl(process.env) });
    const agent = (await client.harnesses()).find((harness) => harness.agent === 'codex');
    if (!agent?.installed || agent.signedIn === false)
      context.skip('Codex must be installed and signed in.');
    const prefix = `smoke-${randomUUID().slice(0, 8)}`;
    const session = await client.createSession(
      projectId,
      {
        title: 'Orchestrator planning smoke',
        agent: 'codex',
        interface: 'chat',
        planWithOrchestrator: true,
        prompt: `Inspect this repository read-only and plan a small greeting feature: a shared request/response contract and two independent consumers (service and screen). Submit exactly three nodes, with both consumers depending on the contract node. Use node ids prefixed ${prefix}. Do not implement or approve anything. Record why the contract is needed using helix explain with its node id.`,
      },
      { idempotencyKey: randomUUID() },
    );
    const history = async () => {
      const events: HelixEvent[] = [];
      let since = 0;
      for (;;) {
        const page = await client.projectEvents(projectId, { since, limit: 1000 });
        if (!page.events.length) return events;
        if (page.lastSeq <= since) throw new Error('Event cursor did not advance');
        events.push(...page.events);
        since = page.lastSeq;
      }
    };
    try {
      expect(session.role).toBe('orchestrator');
      await expect
        .poll(
          async () =>
            (await history()).some(
              (event) =>
                event.type === 'plan.submitted' &&
                event.payload.plan.orchestratorSessionId === session.id,
            ),
          { timeout: 90_000, interval: 1000 },
        )
        .toBe(true);
      const events = await history();
      const state = projectUpTo(events, events.at(-1)!.seq);
      const plan = Object.values(state.plans).find(
        (entry) => entry.orchestratorSessionId === session.id,
      )!;
      expect(plan.status).toBe('awaiting_approval');
      expect(plan.nodes).toHaveLength(3);
      const contract = plan.nodes.find((node) => node.dependsOn.length === 0)!;
      expect(contract).toBeDefined();
      for (const node of plan.nodes) {
        expect(node.files.length).toBeGreaterThan(0);
        expect(node.sessionId).toBeUndefined();
        expect(plan.nodeStatus[node.id]).toBe('pending');
        if (node !== contract) expect(node.dependsOn).toEqual([contract.id]);
      }
      expect(
        Object.values(state.sessions).some((entry) => entry.session.parentSessionId === session.id),
      ).toBe(false);
      const stdout: string[] = [];
      expect(
        await runCli(['plan', 'show', plan.id, '--json'], {
          client,
          stdout: (text) => stdout.push(text),
        }),
      ).toBe(0);
      expect(JSON.parse(stdout[0]!)).toEqual(plan);
      await expect
        .poll(
          async () =>
            (await history()).some(
              (event) =>
                event.type === 'explain.note' &&
                event.sessionId === session.id &&
                event.planNodeId === contract.id,
            ),
          { timeout: 15_000, interval: 500 },
        )
        .toBe(true);
      // The orchestrator may finish its user-facing reply just after submission.
      await expect
        .poll(
          async () => {
            const current = await history();
            const projected = projectUpTo(current, current.at(-1)!.seq);
            return projected.sessions[session.id]?.activity;
          },
          { timeout: 15_000, interval: 500 },
        )
        .toBe('idle');
      const finalEvents = await history();
      const finalState = projectUpTo(finalEvents, finalEvents.at(-1)!.seq);
      expect(finalState.plans[plan.id]?.status).toBe('awaiting_approval');
      expect(
        Object.values(finalState.sessions).some(
          (entry) => entry.session.parentSessionId === session.id,
        ),
      ).toBe(false);
    } finally {
      await client.stopSession(session.id);
    }
  },
  130_000,
);
