import { describe, expect, it } from 'vitest';
import { workspaceTitle } from '../../src/features/workspace/workspace-title';

describe('workspace title', () => {
  it('shows the project and host normally', () => {
    expect(workspaceTitle('puddle', 'vya-micaseed', 0)).toBe('puddle — vya-micaseed');
  });

  it('keeps the hostname when sessions are waiting', () => {
    expect(workspaceTitle('puddle', 'vya-micaseed', 1)).toBe('● 1 waiting — puddle (vya-micaseed)');
    expect(workspaceTitle('mlmp', 'remote-dev', 3)).toBe('● 3 waiting — mlmp (remote-dev)');
  });
});
