import { describe, expect, it } from 'vitest';
import {
  releaseArchiveName,
  releaseAssetUrl,
  releaseTarget,
} from '../../src/lib/installation/releases.js';

describe('release asset names', () => {
  it('keeps the POSIX archive names the release workflow publishes', () => {
    expect(releaseArchiveName('puddled', '0.3.14', 'linux', 'x64')).toBe(
      'puddled-v0.3.14-linux-x64.tar.gz',
    );
    expect(releaseArchiveName('puddled', '0.3.14', 'linux', 'arm64')).toBe(
      'puddled-v0.3.14-linux-arm64.tar.gz',
    );
    expect(releaseArchiveName('puddle-cli', '0.3.14', 'darwin', 'arm64')).toBe(
      'puddle-cli-v0.3.14-darwin-arm64.tar.gz',
    );
  });

  it('names the native zip for each Windows architecture', () => {
    expect(releaseArchiveName('puddled', '0.3.14', 'win32', 'x64')).toBe(
      'puddled-v0.3.14-win32-x64.zip',
    );
    expect(releaseArchiveName('puddle-cli', '0.3.14', 'win32', 'x64')).toBe(
      'puddle-cli-v0.3.14-win32-x64.zip',
    );
    expect(releaseArchiveName('puddled', '0.3.14', 'win32', 'arm64')).toBe(
      'puddled-v0.3.14-win32-arm64.zip',
    );
    expect(releaseArchiveName('puddle-cli', '0.3.14', 'win32', 'arm64')).toBe(
      'puddle-cli-v0.3.14-win32-arm64.zip',
    );
    expect(releaseTarget('win32', 'arm64')).toBe('win32-arm64');
    expect(() => releaseTarget('win32', 'ia32')).toThrow('no Windows ia32 build');
    expect(() => releaseArchiveName('puddled', '0.3.14', 'win32', 'ia32')).toThrow(
      'no Windows ia32 build',
    );
  });

  it('downloads assets from the tagged GitHub release', () => {
    expect(releaseAssetUrl('acme/puddle', '0.3.14', 'SHA256SUMS')).toBe(
      'https://github.com/acme/puddle/releases/download/v0.3.14/SHA256SUMS',
    );
  });
});
