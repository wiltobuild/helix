import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createHelixClient } from '@helix/api-client';
import { fixtures } from '@helix/contracts';
import { runCli } from './index.js';

const submitted = fixtures.crossReviewRun.find((e) => e.type === 'agent_review.submitted')!;
function fixture() {
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(Response.json(submitted, { status: 201 })),
  );
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();
  return {
    fetcher,
    options: {
      client: createHelixClient({ baseUrl: 'http://127.0.0.1:4317', fetch: fetcher }),
      stdout,
      stderr,
      env: { HELIX_SESSION_ID: submitted.sessionId },
    },
  };
}

function bodyOf(call: Parameters<typeof fetch>): unknown {
  const body = call[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON body');
  return JSON.parse(body) as unknown;
}
test.each([false, true])(
  'review submit reads a verdict file and prints a result (json=%s)',
  async (json) => {
    const f = fixture();
    const cwd = await mkdtemp(path.join(tmpdir(), 'helix-review-cli-'));
    try {
      await writeFile(path.join(cwd, 'verdict.json'), JSON.stringify(submitted.payload.review));
      expect(
        await runCli(
          [
            'review',
            'submit',
            'verdict.json',
            '--head',
            submitted.payload.headSha,
            ...(json ? ['--json'] : []),
          ],
          { ...f.options, cwd },
        ),
      ).toBe(0);
      const url = f.fetcher.mock.calls[0]![0];
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        'http://127.0.0.1:4317/api/reviews',
      );
      expect(bodyOf(f.fetcher.mock.calls[0]!)).toEqual({
        reviewerSessionId: submitted.sessionId,
        headSha: submitted.payload.headSha,
        review: submitted.payload.review,
      });
      if (json) expect(JSON.parse(f.options.stdout.mock.calls[0]![0])).toEqual(submitted);
      else
        expect(f.options.stdout.mock.calls[0]![0]).toContain('Submitted request_changes for PR #7');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
test('stdin submissions use --head on every invocation', async () => {
  const f = fixture();
  for (const head of ['first', 'second']) {
    expect(
      await runCli(['review', 'submit', '-', '--head', head], {
        ...f.options,
        stdin: () => Promise.resolve(JSON.stringify(submitted.payload.review)),
      }),
    ).toBe(0);
    expect(bodyOf(f.fetcher.mock.calls.at(-1)!)).toMatchObject({ headSha: head });
  }
});
test.each(['head', 'identity', 'json', 'schema'])(
  'review submit validates %s before contacting daemon',
  async (kind) => {
    const f = fixture();
    const args = ['review', 'submit', '-', ...(kind === 'head' ? [] : ['--head', 'head'])];
    const result = await runCli(args, {
      ...f.options,
      env: kind === 'identity' ? {} : f.options.env,
      stdin: () =>
        Promise.resolve(
          kind === 'json'
            ? '{'
            : JSON.stringify({ verdict: 'maybe', summary: '', findings: [{ severity: 'bad' }] }),
        ),
    });
    expect(result).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    const errors = f.options.stderr.mock.calls.flat().join('\n');
    expect(errors).toContain('INVALID_REQUEST');
    if (kind === 'schema')
      for (const field of ['review.verdict', 'review.summary', 'review.findings.0.severity'])
        expect(errors).toContain(field);
  },
);
test('daemon stale-head errors remain readable and exit 2', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    Response.json(
      { error: { code: 'INVALID_REQUEST', message: 'The PR moved on; review the new head' } },
      { status: 400 },
    ),
  );
  expect(
    await runCli(['review', 'submit', '-', '--head', 'old'], {
      ...f.options,
      stdin: () => Promise.resolve(JSON.stringify(submitted.payload.review)),
    }),
  ).toBe(2);
  expect(f.options.stderr.mock.calls[0]![0]).toContain('PR moved on');
});
