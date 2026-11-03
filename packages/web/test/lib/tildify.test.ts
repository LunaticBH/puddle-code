import { describe, expect, it } from 'vitest';
import { tildify } from '../../src/lib/tildify';

describe('tildify', () => {
  it('compresses the home prefix on Linux and macOS layouts', () => {
    expect(tildify('/home/alice/.puddle/worktrees/1/x', '/home/alice')).toBe(
      '~/.puddle/worktrees/1/x',
    );
    expect(tildify('/Users/alice/code/app', '/Users/alice')).toBe('~/code/app');
    expect(tildify('/Users/alice', '/Users/alice')).toBe('~');
  });

  it('tolerates a trailing slash on home', () => {
    expect(tildify('/home/alice/x', '/home/alice/')).toBe('~/x');
  });

  it('only matches whole path segments', () => {
    expect(tildify('/Users/alice-backup/x', '/Users/alice')).toBe('/Users/alice-backup/x');
  });

  it('passes through when home is unknown, empty, or the filesystem root', () => {
    expect(tildify('/srv/repo', undefined)).toBe('/srv/repo');
    expect(tildify('/srv/repo', '')).toBe('/srv/repo');
    expect(tildify('/srv/repo', '/')).toBe('/srv/repo');
  });

  it('leaves paths outside home untouched', () => {
    expect(tildify('/opt/data', '/home/alice')).toBe('/opt/data');
  });

  it('compresses a Windows home to ~\\ in the host’s own syntax', () => {
    expect(tildify('C:\\Users\\alice\\code\\app', 'C:\\Users\\alice')).toBe('~\\code\\app');
    expect(tildify('C:\\Users\\alice', 'C:\\Users\\alice')).toBe('~');
    expect(tildify('C:\\Users\\alice\\x', 'C:\\Users\\alice\\')).toBe('~\\x');
  });

  it('matches a Windows home regardless of case and separator', () => {
    expect(tildify('c:/users/Alice/repo', 'C:\\Users\\alice')).toBe('~\\repo');
  });

  it('keeps Windows segment boundaries and leaves other drives alone', () => {
    expect(tildify('C:\\Users\\alice-backup\\x', 'C:\\Users\\alice')).toBe(
      'C:\\Users\\alice-backup\\x',
    );
    expect(tildify('D:\\src\\app', 'C:\\Users\\alice')).toBe('D:\\src\\app');
  });

  it('never compresses a Windows drive root used as home', () => {
    expect(tildify('C:\\src', 'C:\\')).toBe('C:\\src');
  });
});
