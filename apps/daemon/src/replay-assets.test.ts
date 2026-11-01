import { expect, it, vi } from 'vitest';
import { eventSchemas, eventSeqSchema, fixtures, projectIdSchema } from '@helix/contracts';
import { ReplayAssets } from './replay-assets.js';

const base = fixtures.passwordResetRun[0]!;
const image = `data:image/png;base64,${Buffer.from('raster bytes').toString('base64')}`;
const event = eventSchemas['design.updated'].parse({
  ...base,
  type: 'design.updated',
  payload: {
    design: {
      sessionId: fixtures.crossReviewIds.worker,
      revision: 1,
      brief: 'A storefront',
      status: 'ready',
      rounds: [
        {
          revision: 1,
          jobId: 'round-one',
          concepts: [
            {
              id: 'one',
              title: 'First',
              imageUrl: image,
              mimeType: 'image/png',
              prompt: 'Draw',
              rationale: 'Readable',
              tradeoffs: [],
              recommended: true,
            },
          ],
        },
      ],
      conversation: [],
      references: [],
      receipts: [],
    },
  },
});

it('replaces repeated raster payloads with stable loopback URLs without mutating recorded events', async () => {
  const assets = new ReplayAssets();
  const first = assets.forStream(event, 'http://127.0.0.1:4322');
  const second = assets.forStream(
    { ...event, seq: eventSeqSchema.parse(event.seq + 1) },
    'http://127.0.0.1:4322',
  );
  if (first.type !== 'design.updated' || second.type !== 'design.updated')
    throw new Error('Wrong type');
  const url = first.payload.design.rounds[0]!.concepts[0]!.imageUrl;
  expect(url).toMatch(
    new RegExp(
      `^http://127\\.0\\.0\\.1:4322/api/replay-assets/${event.projectId}/${event.seq}/[a-f0-9]{64}$`,
    ),
  );
  expect(second.payload.design.rounds[0]!.concepts[0]!.imageUrl).toBe(url);
  const otherProject = assets.forStream(
    { ...event, projectId: projectIdSchema.parse('proj_other_replay') },
    'http://127.0.0.1:4322',
  );
  if (otherProject.type !== 'design.updated') throw new Error('Wrong type');
  expect(otherProject.payload.design.rounds[0]!.concepts[0]!.imageUrl).not.toBe(url);
  expect(event.payload.design.rounds[0]!.concepts[0]!.imageUrl).toBe(image);
  expect(eventSchemas['design.updated'].safeParse(first).success).toBe(true);
  const hash = url.split('/').at(-1)!;
  expect(assets.get(hash)).toMatchObject({
    mimeType: 'image/png',
    bytes: Buffer.from('raster bytes'),
  });
  const missing = vi.fn(() => Promise.resolve([]));
  await expect(
    assets.resolve(projectIdSchema.parse('proj_never_issued_replay'), event.seq, hash, {
      read: missing,
    }),
  ).resolves.toBeUndefined();
  await expect(
    assets.resolve(event.projectId, event.seq + 1, hash, { read: missing }),
  ).resolves.toBeUndefined();
  expect(missing).toHaveBeenCalledTimes(2);
});

it('resolves an old URL after restart and when the bounded cache is full', async () => {
  const fullCache = new ReplayAssets(1);
  const streamed = fullCache.forStream(event, 'http://127.0.0.1:4322');
  if (streamed.type !== 'design.updated') throw new Error('Wrong type');
  const url = streamed.payload.design.rounds[0]!.concepts[0]!.imageUrl;
  expect(url).not.toContain('base64');
  const hash = url.split('/').at(-1)!;
  expect(fullCache.get(hash)).toBeUndefined();
  const read = { read: () => Promise.resolve([event]) };
  const asset = await fullCache.resolve(event.projectId, event.seq, hash, read);
  expect(asset?.bytes).toEqual(Buffer.from('raster bytes'));
  expect(fullCache.get(hash)).toBeUndefined();
  const afterRestart = new ReplayAssets(1);
  expect((await afterRestart.resolve(event.projectId, event.seq, hash, read))?.bytes).toEqual(
    Buffer.from('raster bytes'),
  );
  expect(await afterRestart.resolve(event.projectId, event.seq + 1, hash, read)).toBeUndefined();
});

it('bounds content references while keeping old URLs resolvable from history', async () => {
  const assets = new ReplayAssets(1, 2);
  const snapshot = (seq: number, text: string) =>
    eventSchemas['design.updated'].parse({
      ...event,
      seq,
      payload: {
        design: {
          ...event.payload.design,
          rounds: [
            {
              ...event.payload.design.rounds[0],
              concepts: [
                {
                  ...event.payload.design.rounds[0]!.concepts[0],
                  imageUrl: `data:image/png;base64,${Buffer.from(text).toString('base64')}`,
                },
              ],
            },
          ],
        },
      },
    });
  const first = snapshot(1, 'first');
  const firstUrl = assets.forStream(first, 'http://127.0.0.1:4322');
  assets.forStream(snapshot(2, 'second'), 'http://127.0.0.1:4322');
  assets.forStream(snapshot(3, 'third'), 'http://127.0.0.1:4322');
  const repeated = assets.forStream(snapshot(4, 'first'), 'http://127.0.0.1:4322');
  if (firstUrl.type !== 'design.updated' || repeated.type !== 'design.updated')
    throw new Error('Wrong type');
  const oldUrl = firstUrl.payload.design.rounds[0]!.concepts[0]!.imageUrl;
  const newUrl = repeated.payload.design.rounds[0]!.concepts[0]!.imageUrl;
  expect(oldUrl).toContain('/1/');
  expect(newUrl).toContain('/4/');
  expect(newUrl).not.toBe(oldUrl);
  expect(
    (
      await assets.resolve(first.projectId, first.seq, oldUrl.split('/').at(-1)!, {
        read: () => Promise.resolve([first]),
      })
    )?.bytes,
  ).toEqual(Buffer.from('first'));
});

it('resolves a second asset when accumulated cached bytes reach the limit', async () => {
  const otherImage = `data:image/png;base64,${Buffer.from('other').toString('base64')}`;
  const withTwoImages = eventSchemas['design.updated'].parse({
    ...event,
    payload: {
      design: {
        ...event.payload.design,
        rounds: [
          {
            ...event.payload.design.rounds[0],
            concepts: [
              event.payload.design.rounds[0]!.concepts[0],
              { ...event.payload.design.rounds[0]!.concepts[0], id: 'two', imageUrl: otherImage },
            ],
          },
        ],
      },
    },
  });
  const assets = new ReplayAssets(16);
  const streamed = assets.forStream(withTwoImages, 'http://127.0.0.1:4322');
  if (streamed.type !== 'design.updated') throw new Error('Wrong type');
  const [first, second] = streamed.payload.design.rounds[0]!.concepts;
  const firstHash = first!.imageUrl.split('/').at(-1)!;
  const secondHash = second!.imageUrl.split('/').at(-1)!;
  expect(assets.get(firstHash)?.bytes).toEqual(Buffer.from('raster bytes'));
  expect(assets.get(secondHash)).toBeUndefined();
  expect(
    (
      await assets.resolve(withTwoImages.projectId, withTwoImages.seq, secondHash, {
        read: () => Promise.resolve([withTwoImages]),
      })
    )?.bytes,
  ).toEqual(Buffer.from('other'));
  expect(assets.get(secondHash)).toBeUndefined();
});

it('externalizes mixed-case raster data URLs accepted by the contract', async () => {
  const mixedImage = image.replace('data:image/png;base64,', 'DATA:image/PNG;BASE64,');
  const mixed = eventSchemas['design.updated'].parse({
    ...event,
    payload: {
      design: {
        ...event.payload.design,
        rounds: [
          {
            ...event.payload.design.rounds[0],
            concepts: [{ ...event.payload.design.rounds[0]!.concepts[0], imageUrl: mixedImage }],
          },
        ],
      },
    },
  });
  const assets = new ReplayAssets(1);
  const streamed = assets.forStream(mixed, 'http://127.0.0.1:4322');
  if (streamed.type !== 'design.updated') throw new Error('Wrong type');
  const url = streamed.payload.design.rounds[0]!.concepts[0]!.imageUrl;
  expect(url).toContain('/api/replay-assets/');
  expect(
    (
      await assets.resolve(mixed.projectId, mixed.seq, url.split('/').at(-1)!, {
        read: () => Promise.resolve([mixed]),
      })
    )?.mimeType,
  ).toBe('image/png');
});
