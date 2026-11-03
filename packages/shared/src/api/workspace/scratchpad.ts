import { z } from 'zod';
import { isoTimestamp, profileId, projectId, rowId } from '../common.js';

/**
 * The Scratchpad (SPEC §11): a per-profile bank of reusable prompts and notes.
 * Each entry is either **project**-scoped (shown only in its project) or
 * **profile**-scoped (shown in every project of the profile) — a hard filter,
 * unlike the earlier prompt-bank design where the project was a ranking hint.
 * `agent_type` and `tags` are optional associations used for filtering the
 * panel; `position` is the manual drag order (smaller = higher, so a freshly
 * created entry sorts to the top).
 */
export const scratchpadScopeSchema = z.enum(['project', 'profile']);
export type ScratchpadScope = z.infer<typeof scratchpadScopeSchema>;

export const scratchpadEntrySchema = z.object({
  id: rowId,
  profile_id: profileId,
  scope: scratchpadScopeSchema,
  /** Set iff `scope === 'project'` — the project the entry belongs to. */
  project_id: projectId.nullable(),
  title: z.string().nullable(),
  body: z.string(),
  tags: z.array(z.string()),
  agent_type: z.string().nullable(),
  position: z.number(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type ScratchpadEntry = z.infer<typeof scratchpadEntrySchema>;

/**
 * POST /api/scratchpad — a `project`-scoped entry must carry `project_id`; a
 * `profile`-scoped one must omit it (the daemon enforces the pairing and 400s
 * a mismatch). `position` is assigned server-side (top of the list).
 */
export const createScratchpadRequestSchema = z.object({
  profile_id: profileId,
  scope: scratchpadScopeSchema,
  project_id: projectId.optional(),
  title: z.string().max(200).optional(),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  agent_type: z.string().optional(),
});
export type CreateScratchpadRequest = z.infer<typeof createScratchpadRequestSchema>;

/**
 * PATCH /api/scratchpad/:id — every field optional. `position` alone is the
 * drag-reorder write (the client sends the fractional midpoint of the entry's
 * new neighbours). Changing `scope` re-pairs `project_id` (send both).
 */
export const patchScratchpadRequestSchema = z.object({
  scope: scratchpadScopeSchema.optional(),
  project_id: projectId.nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  body: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  agent_type: z.string().nullable().optional(),
  position: z.number().optional(),
});
export type PatchScratchpadRequest = z.infer<typeof patchScratchpadRequestSchema>;
