import { describe, expect, it } from 'vitest';
import { deriveAbbrev, normaliseAbbrev, projectAbbrev } from '../../src/lib/project-abbrev';

describe('deriveAbbrev', () => {
  it('uppercases the first five characters of the trimmed name', () => {
    expect(deriveAbbrev('puddle')).toBe('PUDDL');
    expect(deriveAbbrev('  api ')).toBe('API');
    expect(deriveAbbrev('go')).toBe('GO');
  });
});

describe('projectAbbrev', () => {
  it('prefers the stored abbreviation, else derives from the name', () => {
    expect(projectAbbrev({ name: 'puddle', abbrev: 'PDL' })).toBe('PDL');
    expect(projectAbbrev({ name: 'puddle', abbrev: null })).toBe('PUDDL');
    expect(projectAbbrev({ name: 'puddle' })).toBe('PUDDL');
  });
});

describe('normaliseAbbrev', () => {
  it('trims, uppercases, and clamps input', () => {
    expect(normaliseAbbrev(' pdl ')).toBe('PDL');
    expect(normaliseAbbrev('toolong')).toBe('TOOLO');
    expect(normaliseAbbrev('  ')).toBe('');
  });
});
