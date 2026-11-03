import { Hono } from 'hono';
import { latexSynctexRequestSchema, type LatexSynctexResponse } from '@puddle/shared';
import type { LatexProvider } from '../../../latex/provider.js';
import { parseBody } from '../../validate.js';

export function latexRoutes(deps: { latex: LatexProvider }): Hono {
  return new Hono().post('/synctex', async (c) => {
    const request = await parseBody(c, latexSynctexRequestSchema);
    return c.json<LatexSynctexResponse>(await deps.latex.inverseSearch(request));
  });
}
