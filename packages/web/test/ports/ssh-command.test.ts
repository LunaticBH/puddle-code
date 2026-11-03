import { describe, expect, it } from 'vitest';
import { sshForwardCommand } from '../../src/features/ports/ssh-command';

describe('sshForwardCommand', () => {
  it('builds a local-forward command for the given port and host', () => {
    expect(sshForwardCommand(5173, 'alice', 'devbox')).toBe(
      'ssh -L 5173:127.0.0.1:5173 alice@devbox',
    );
  });

  it('interpolates a different port/user/host combination', () => {
    expect(sshForwardCommand(8080, 'root', '10.0.0.5')).toBe(
      'ssh -L 8080:127.0.0.1:8080 root@10.0.0.5',
    );
  });
});
