import { z } from 'zod';
import { sessionIdSchema } from './ids.js';
const safeUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'Use an HTTP or HTTPS URL');
const rasterUrl = z
  .string()
  .url()
  .refine(
    (v) => /^https?:\/\//i.test(v) || /^data:image\/(?:png|jpeg|webp);base64,/i.test(v),
    'Use a raster data URL or HTTP image URL',
  );
const text = z.string().trim().min(1).max(24000);
export const visualReferenceSchema = z.strictObject({ url: rasterUrl, label: text.optional() });
export const visualConceptSchema = z.strictObject({
  id: text,
  title: text,
  assetPath: text.optional(),
  imageUrl: rasterUrl,
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  prompt: text,
  rationale: text,
  tradeoffs: z.array(text),
  recommended: z.boolean(),
});
export const visualDesignSchema = z.strictObject({
  sessionId: sessionIdSchema,
  revision: z.number().int().positive(),
  brief: text,
  status: z.enum(['pending', 'ready', 'approved', 'failed', 'unavailable', 'cancelled']),
  rounds: z.array(
    z.strictObject({
      revision: z.number().int().positive(),
      jobId: text,
      concepts: z.array(visualConceptSchema).max(3),
    }),
  ),
  conversation: z.array(
    z.strictObject({
      role: z.enum(['user', 'helix']),
      text,
      revision: z.number().int().positive(),
      references: z.array(visualReferenceSchema),
    }),
  ),
  references: z.array(visualReferenceSchema),
  decision: z
    .strictObject({
      revision: z.number().int().positive(),
      conceptIds: z.array(text).min(1).max(3),
      rationale: text,
    })
    .optional(),
  checkpoint: z
    .strictObject({
      previewUrl: safeUrl,
      workerSessionId: sessionIdSchema,
      headSha: text,
      recommendation: text,
      reducedMotion: z.boolean(),
    })
    .optional(),
  blocker: text.optional(),
  receipts: z.array(z.strictObject({ requestId: text, hash: text })),
});
export const visualDesignRequestSchema = z.strictObject({
  requestId: z.string().min(1).max(255),
  revision: z.number().int().positive(),
  action: z.enum(['comment', 'regenerate', 'approve', 'cancel', 'retry', 'checkpoint']),
  text: text.optional(),
  conceptIds: z.array(text).max(3).optional(),
  references: z.array(visualReferenceSchema).max(20).optional(),
  checkpoint: visualDesignSchema.shape.checkpoint.optional(),
});
export const visualDesignResponseSchema = z.strictObject({ design: visualDesignSchema.nullable() });
export type VisualDesign = z.infer<typeof visualDesignSchema>;
export type VisualDesignRequest = z.infer<typeof visualDesignRequestSchema>;
export type VisualConcept = z.infer<typeof visualConceptSchema>;
