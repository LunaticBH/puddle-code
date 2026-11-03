import { describe, expect, it } from 'vitest';
import {
  clearCompilationDiagnostics,
  compilationDiagnosticsFor,
  setCompilationDiagnostics,
} from '../../../src/features/editor/compilation/compilation-diagnostics-store';

describe('compilation diagnostics store', () => {
  it('routes included-file diagnostics by rooted file identity and clears by build owner', () => {
    const source = {
      session: '11111111-1111-4111-8111-111111111111',
      root: '/project',
      path: 'chapters/one.tex',
    };
    setCompilationDiagnostics('build:paper', [
      { source, severity: 'error', message: 'Undefined control sequence.', line: 7 },
    ]);
    expect(compilationDiagnosticsFor(source)).toMatchObject([
      { message: 'Undefined control sequence.', line: 7 },
    ]);

    clearCompilationDiagnostics('build:paper');
    expect(compilationDiagnosticsFor(source)).toEqual([]);
  });
});
