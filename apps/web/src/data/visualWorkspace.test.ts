import { expect, test, vi } from 'vitest';
import {
  canChooseRound,
  parseVisualReferences,
  VisualSubmission,
  visualUrl,
  type VisualCommand,
} from './visualWorkspace';

const draft: Omit<VisualCommand, 'requestId'> = {
  workspaceId: 'session',
  revision: 2,
  roundId: 'round-2',
  action: 'regenerate',
  conceptIds: [],
  feedback: 'Try three warmer directions',
  references: [],
};

test('reject-all ignores repeated in-flight clicks and retries an uncertain response with the same identity', async () => {
  let reject!: (reason: Error) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(undefined);
  const submission = new VisualSubmission(() => 'stable-request');
  const pending = submission.send(draft, { send });
  expect(await submission.send(draft, { send })).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  reject(new Error('Response lost'));
  await expect(pending).rejects.toThrow('Response lost');
  await submission.send(draft, { send });
  expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
  expect(send.mock.calls[1]?.[0]).toMatchObject({
    action: 'regenerate',
    revision: 2,
    requestId: 'stable-request',
  });
});

test('an unresolved decision cannot turn into a different request without fresh server state', async () => {
  const submission = new VisualSubmission(() => 'request');
  const send = vi.fn().mockRejectedValue(new Error('Lost connection'));
  await expect(submission.send(draft, { send })).rejects.toThrow();
  await expect(
    submission.send({ ...draft, action: 'approve', conceptIds: ['one'] }, { send }),
  ).rejects.toThrow('uncertain outcome');
  expect(send).toHaveBeenCalledTimes(1);
});

test('concept approval requires exactly three actual image references and a ready round', () => {
  const concept = {
    id: 'one',
    title: 'One',
    imageUrl: '/api/image/one.png',
    alt: 'One render',
    rationale: 'Reason',
    tradeoffs: [],
  };
  const round = {
    id: 'round',
    revision: 1,
    status: 'ready' as const,
    brief: 'Brief',
    concepts: [concept, { ...concept, id: 'two' }, { ...concept, id: 'three' }],
  };
  expect(canChooseRound(round)).toBe(true);
  expect(canChooseRound({ ...round, concepts: [concept] })).toBe(false);
  expect(canChooseRound({ ...round, status: 'pending' })).toBe(false);
  expect(
    canChooseRound({
      ...round,
      concepts: [concept, concept, { ...concept, imageUrl: 'javascript:alert(1)' }],
    }),
  ).toBe(false);
});

test('reference links accept image and website URLs, deduplicate, and reject executable or credential URLs', () => {
  expect(
    parseVisualReferences(
      'https://example.com/image.png\nhttps://example.com/image.png\nhttps://example.com',
    ),
  ).toEqual(['https://example.com/image.png', 'https://example.com']);
  expect(() => parseVisualReferences('javascript:alert(1)')).toThrow();
  expect(() => parseVisualReferences('https://user:password@example.com')).toThrow();
  expect(visualUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
});
