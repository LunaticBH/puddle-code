import { Hono } from 'hono';
import {
  compilationDefaultsRequestSchema,
  updateCompilationDefaultsRequestSchema,
  type CompilationDefaultsResponse,
  compilationModeRequestSchema,
  compilationRunRequestSchema,
  compilationSettingsRequestSchema,
  compilationTargetRequestSchema,
  updateCompilationSettingsRequestSchema,
  type CompilationCapabilitiesResponse,
  type CompilationRunResponse,
  type CompilationSettingsResponse,
  type CompilationStatusResponse,
} from '@puddle/shared';
import type { CompilationService } from '../../../compilation/service.js';
import { parseBody } from '../../validate.js';

export function compilationRoutes(deps: { compilation: CompilationService }): Hono {
  return new Hono()
    .get('/capabilities', (c) =>
      c.json<CompilationCapabilitiesResponse>(deps.compilation.capabilities()),
    )
    .post('/run', async (c) => {
      const request = await parseBody(c, compilationRunRequestSchema);
      return c.json<CompilationRunResponse>(await deps.compilation.run(request));
    })
    .post('/defaults', async (c) => {
      const request = await parseBody(c, compilationDefaultsRequestSchema);
      return c.json<CompilationDefaultsResponse>(deps.compilation.defaults(request));
    })
    .put('/defaults', async (c) => {
      const request = await parseBody(c, updateCompilationDefaultsRequestSchema);
      return c.json<CompilationDefaultsResponse>(deps.compilation.updateDefaults(request));
    })
    .post('/settings', async (c) => {
      const request = await parseBody(c, compilationSettingsRequestSchema);
      return c.json<CompilationSettingsResponse>(deps.compilation.settings(request));
    })
    .put('/settings', async (c) => {
      const request = await parseBody(c, updateCompilationSettingsRequestSchema);
      return c.json<CompilationSettingsResponse>(deps.compilation.updateSettings(request));
    })
    .put('/mode', async (c) => {
      const request = await parseBody(c, compilationModeRequestSchema);
      return c.json<CompilationStatusResponse>(await deps.compilation.setMode(request));
    })
    .post('/status', async (c) => {
      const request = await parseBody(c, compilationTargetRequestSchema);
      return c.json<CompilationStatusResponse>(deps.compilation.status(request));
    });
}
