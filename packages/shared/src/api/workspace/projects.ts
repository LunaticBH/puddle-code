import { z } from 'zod';
import { isoTimestamp, profileId, projectId, rowId } from '../common.js';
import { sessionSchema } from '../agents/sessions.js';
import { PROFILE_ICON_COLOURS } from '../profiles.js';

/**
 * The compact label the collapsed sidebar rail shows for a project (12.1,
 * SPEC §12): at most five characters, stored uppercase. Null on projects
 * created before the field existed — displays derive from the name then.
 */
const projectAbbrev = z.string().min(1).max(5);
/** Projects share the profile icon palette; null restores the usual name styling. */
export const projectColourSchema = z.enum(PROFILE_ICON_COLOURS);
export type ProjectColour = z.infer<typeof projectColourSchema>;

export const projectSchema = z.object({
  id: projectId,
  profile_id: profileId,
  repo_id: rowId,
  name: z.string(),
  abbrev: projectAbbrev.nullable().default(null),
  colour: projectColourSchema.nullable().optional(),
  /**
   * Hidden from the homescreen but never deleted — every session, worktree, and
   * bit of data is retained, and un-archiving restores it all (SPEC §11).
   * Defaults false so an older daemon that omits it reads as not-archived.
   */
  archived: z.boolean().default(false),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({
  profile_id: profileId,
  repo_id: rowId,
  name: z.string().min(1).max(100),
  abbrev: projectAbbrev.optional(),
  colour: projectColourSchema.nullable().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** PATCH /api/projects/:id — edit a project's appearance and/or archive/unarchive it. */
export const patchProjectRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  abbrev: projectAbbrev.optional(),
  colour: projectColourSchema.nullable().optional(),
  archived: z.boolean().optional(),
});
export type PatchProjectRequest = z.infer<typeof patchProjectRequestSchema>;

export const projectDetailSchema = z.object({
  project: projectSchema,
  sessions: z.array(sessionSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
