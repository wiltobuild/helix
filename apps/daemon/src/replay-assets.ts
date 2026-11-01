import { createHash } from 'node:crypto';
import type { EventStore, HelixEvent, ProjectId } from '@helix/contracts';

const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_REFS = 8192;
// Match the same raster prefix as the contract. Do not fall back to inline data
// because a large malformed/whitespace-containing URL could stall SSE forever.
const dataImage = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]*)$/i;

/**
 * Keep raster bytes out of repeated SSE design snapshots. The event store remains
 * untouched, so exports and replay still retain the complete historical record.
 * Assets are content-addressed and only served by the same loopback daemon.
 */
export class ReplayAssets {
  private readonly assets = new Map<string, { bytes: Buffer; mimeType: string }>();
  // Keep repeat snapshots on one stable, event-backed URL without retaining
  // an unbounded index of every visual the daemon has ever seen.
  private readonly firstRefs = new Map<string, number>();
  private bytes = 0;
  constructor(
    private readonly maxCacheBytes = MAX_CACHE_BYTES,
    private readonly maxContentRefs = MAX_CONTENT_REFS,
  ) {}

  get(hash: string) {
    return this.assets.get(hash);
  }

  private remember(hash: string, mimeType: string, encoded: string, decodeOnFull = false) {
    if (this.assets.has(hash)) return this.assets.get(hash)!;
    // A full cache affects speed only. The URL still resolves from the event store.
    if (!decodeOnFull && encoded.length > (this.maxCacheBytes - this.bytes) * 2) return undefined;
    const bytes = Buffer.from(encoded, 'base64');
    if (this.bytes + bytes.length > this.maxCacheBytes) return { bytes, mimeType };
    const asset = { bytes, mimeType };
    this.assets.set(hash, asset);
    this.bytes += bytes.length;
    return asset;
  }

  private url(value: string, origin: string, projectId: ProjectId, seq: number): string {
    if (!/^data:image\//i.test(value)) return value;
    const match = dataImage.exec(value);
    if (!match) return value;
    const [, mimeType, encoded] = match;
    if (!mimeType || !encoded) return value;
    const hash = createHash('sha256').update(value).digest('hex');
    this.remember(hash, mimeType.toLowerCase(), encoded);
    const key = `${projectId}:${hash}`;
    let firstSeq = this.firstRefs.get(key);
    if (firstSeq === undefined) {
      if (this.firstRefs.size >= this.maxContentRefs) {
        const oldest = this.firstRefs.keys().next().value;
        if (oldest !== undefined) this.firstRefs.delete(oldest);
      }
      firstSeq = seq;
      this.firstRefs.set(key, firstSeq);
    }
    return `${origin}/api/replay-assets/${encodeURIComponent(projectId)}/${firstSeq}/${hash}`;
  }

  async resolve(projectId: ProjectId, seq: number, hash: string, events: Pick<EventStore, 'read'>) {
    const cached = this.assets.get(hash);
    // A content hash alone does not bind bytes to the requested project/event.
    // Only skip the historical lookup for a URL this instance actually issued.
    if (cached && this.firstRefs.get(`${projectId}:${hash}`) === seq) return cached;
    const [event] = await events.read(projectId, seq - 1, 1);
    if (event?.seq !== seq || event.type !== 'design.updated') return undefined;
    const design = event.payload.design;
    const urls = [
      ...design.rounds.flatMap((round) => round.concepts.map((concept) => concept.imageUrl)),
      ...design.references.map((reference) => reference.url),
      ...design.conversation.flatMap((entry) => entry.references.map((reference) => reference.url)),
    ];
    for (const value of urls) {
      if (!/^data:image\//i.test(value)) continue;
      if (createHash('sha256').update(value).digest('hex') !== hash) continue;
      const match = dataImage.exec(value);
      if (!match?.[1] || !match[2]) return undefined;
      return this.remember(hash, match[1].toLowerCase(), match[2], true);
    }
    return undefined;
  }

  forStream(event: HelixEvent, origin: string): HelixEvent {
    if (event.type !== 'design.updated') return event;
    const design = event.payload.design;
    return {
      ...event,
      payload: {
        design: {
          ...design,
          rounds: design.rounds.map((round) => ({
            ...round,
            concepts: round.concepts.map((concept) => ({
              ...concept,
              imageUrl: this.url(concept.imageUrl, origin, event.projectId, event.seq),
            })),
          })),
          references: design.references.map((reference) => ({
            ...reference,
            url: this.url(reference.url, origin, event.projectId, event.seq),
          })),
          conversation: design.conversation.map((entry) => ({
            ...entry,
            references: entry.references.map((reference) => ({
              ...reference,
              url: this.url(reference.url, origin, event.projectId, event.seq),
            })),
          })),
        },
      },
    };
  }
}
