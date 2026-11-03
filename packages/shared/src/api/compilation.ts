import { z } from 'zod';
import { profileId, projectId, sessionId } from './common.js';
import { sessionSchema } from './agents/sessions.js';

/** How a compilable source is driven while its tab is open. */
export const compilationModeSchema = z.enum(['on_demand', 'eager']);
export type CompilationMode = z.infer<typeof compilationModeSchema>;

/** A source or generated file addressed through Puddle's existing file-tab convention. */
export const compilationFileTargetSchema = z.object({
  session: sessionId,
  path: z.string().min(1),
  /** Absolute browse root for an external file; absent for a worktree source. */
  root: z.string().min(1).optional(),
});
export type CompilationFileTarget = z.infer<typeof compilationFileTargetSchema>;

export const compilationProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

/** One modular daemon provider; LaTeX is the first, not a special case in the runner. */
export const compilationProviderSchema = z.object({
  id: compilationProviderIdSchema,
  display_name: z.string().min(1),
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  /** Open dependency buffers saved before a build, in addition to the entry source. */
  input_extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
  available: z.boolean(),
  /** The preferred host executable when available, for honest capability UI. */
  executor: z.string().min(1).nullable(),
  eager: z.boolean(),
  /** Omitted by older providers, whose action remains compilation. */
  action: z.enum(['compile', 'run']).optional(),
  /** Runs always launch a terminal, including any compilation step (25.0). */
  terminal: z.boolean().optional(),
});
export type CompilationProvider = z.infer<typeof compilationProviderSchema>;

/** GET /api/compilation/capabilities — capabilities of the daemon host. */
export const compilationCapabilitiesResponseSchema = z.object({
  providers: z.array(compilationProviderSchema),
});
export type CompilationCapabilitiesResponse = z.infer<typeof compilationCapabilitiesResponseSchema>;

export const compilationTargetRequestSchema = z.object({
  source: compilationFileTargetSchema,
  /** Usually inferred from the extension; explicit for future ambiguous providers. */
  provider: compilationProviderIdSchema.optional(),
  /** Optional project context selects a per-file command override on newer daemons. */
  profile_id: profileId.optional(),
  project_id: projectId.optional(),
});
export type CompilationTargetRequest = z.infer<typeof compilationTargetRequestSchema>;

/** POST /api/compilation/run — one explicit or eager provider run. */
export const compilationRunRequestSchema = compilationTargetRequestSchema;
export type CompilationRunRequest = z.infer<typeof compilationRunRequestSchema>;

export const compilationArtifactSchema = z.object({
  /** Semantic role understood by the UI; `preview` is the primary visual output. */
  role: z.string().min(1),
  media_type: z.string().min(1),
  file: compilationFileTargetSchema,
});
export type CompilationArtifact = z.infer<typeof compilationArtifactSchema>;

/** One provider-normalised source diagnostic, using Monaco-compatible one-based positions. */
export const compilationDiagnosticSchema = z.object({
  source: compilationFileTargetSchema,
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  end_column: z.number().int().positive().optional(),
});
export type CompilationDiagnostic = z.infer<typeof compilationDiagnosticSchema>;

/** Structured detail shared by direct-run errors and pollable eager failures. */
export const compilationFailureDetailsSchema = z.object({
  /** Provider-resolved entry point, used to replace markers across equivalent source tabs. */
  source: compilationFileTargetSchema.optional(),
  /** Bounded compiler output suitable for an expandable UI disclosure. */
  output: z.string().optional(),
  diagnostics: z.array(compilationDiagnosticSchema).optional(),
});
export type CompilationFailureDetails = z.infer<typeof compilationFailureDetailsSchema>;

export const compilationFailureSchema = compilationFailureDetailsSchema.extend({
  message: z.string().min(1),
});
export type CompilationFailure = z.infer<typeof compilationFailureSchema>;

export const compilationRunResponseSchema = z.object({
  provider: compilationProviderIdSchema,
  executor: z.string().min(1),
  /** Monotonic for this source/provider within the daemon lifetime. */
  revision: z.number().int().nonnegative(),
  /** The provider-resolved entry point (for LaTeX, the root TeX document). */
  source: compilationFileTargetSchema,
  artifacts: z.array(compilationArtifactSchema),
  /** Newly launched terminal placement; success means launched, not programme completion. */
  terminal: sessionSchema.optional(),
  /** Provider-owned navigation format available for the artifacts, if any. */
  navigation: z.object({ kind: z.string().min(1) }).optional(),
});
export type CompilationRunResponse = z.infer<typeof compilationRunResponseSchema>;

/** PUT /api/compilation/mode — register or retire daemon-observed eager compilation. */
export const compilationModeRequestSchema = compilationTargetRequestSchema.extend({
  mode: compilationModeSchema,
});
export type CompilationModeRequest = z.infer<typeof compilationModeRequestSchema>;

export const compilationStatusResponseSchema = z.object({
  provider: compilationProviderIdSchema,
  mode: compilationModeSchema,
  state: z.enum(['idle', 'running', 'succeeded', 'failed']),
  revision: z.number().int().nonnegative(),
  result: compilationRunResponseSchema.nullable(),
  error: compilationFailureSchema.nullable(),
});
export type CompilationStatusResponse = z.infer<typeof compilationStatusResponseSchema>;

export const compilationCommandVariableSchema = z.object({
  placeholder: z.string().regex(/^\{\{[a-z][a-z0-9_]*\}\}$/),
  description: z.string().min(1),
});
export type CompilationCommandVariable = z.infer<typeof compilationCommandVariableSchema>;

export const compilationCommandSlotSchema = z.object({
  mode: compilationModeSchema,
  /** Stable trigger copy lets a generic dialog explain exactly when this slot runs. */
  run_when: z.enum(['when_clicked', 'upon_file_change']),
  default_command: z.string().min(1).nullable(),
  override_command: z.string().min(1).nullable(),
  /** Profile language default inherited by this file (24.4); null uses the provider. */
  inherited_command: z.string().min(1).nullable().optional(),
});
export type CompilationCommandSlot = z.infer<typeof compilationCommandSlotSchema>;

/** A project-scoped command-settings lookup for one canonical provider source. */
export const compilationSettingsRequestSchema = compilationTargetRequestSchema.extend({
  profile_id: profileId,
  project_id: projectId,
});
export type CompilationSettingsRequest = z.infer<typeof compilationSettingsRequestSchema>;

export const compilationSettingsResponseSchema = z.object({
  provider: compilationProviderIdSchema,
  display_name: z.string().min(1),
  /** Provider-owned file type used as part of the durable settings identity. */
  file_type: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** Canonical absolute source identity; settings never key on a transient session. */
  file_path: z.string().min(1),
  variables: z.array(compilationCommandVariableSchema),
  commands: z.array(compilationCommandSlotSchema).min(1),
});
export type CompilationSettingsResponse = z.infer<typeof compilationSettingsResponseSchema>;

/** PUT /api/compilation/settings — set one override, or clear it with null. */
export const updateCompilationSettingsRequestSchema = compilationSettingsRequestSchema.extend({
  mode: compilationModeSchema,
  command: z.string().trim().min(1).max(16_384).nullable(),
});
export type UpdateCompilationSettingsRequest = z.infer<
  typeof updateCompilationSettingsRequestSchema
>;

/** Profile-wide language defaults, independent of any open file or project (24.4). */
export const compilationDefaultsRequestSchema = z.object({
  profile_id: profileId,
  provider: compilationProviderIdSchema,
});
export type CompilationDefaultsRequest = z.infer<typeof compilationDefaultsRequestSchema>;

export const compilationDefaultsResponseSchema = compilationSettingsResponseSchema.omit({
  file_type: true,
  file_path: true,
});
export type CompilationDefaultsResponse = z.infer<typeof compilationDefaultsResponseSchema>;

export const updateCompilationDefaultsRequestSchema = compilationDefaultsRequestSchema.extend({
  mode: compilationModeSchema,
  command: updateCompilationSettingsRequestSchema.shape.command,
});
export type UpdateCompilationDefaultsRequest = z.infer<
  typeof updateCompilationDefaultsRequestSchema
>;
