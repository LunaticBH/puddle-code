import { describe, expect, it } from 'vitest';
import { mediaKind } from '../../../src/features/editor/previews/media-kind';

describe('mediaKind', () => {
  it('classifies each media family', () => {
    expect(mediaKind('a/b/photo.PNG')).toBe('image'); // case-insensitive
    expect(mediaKind('logo.svg')).toBe('image');
    expect(mediaKind('clip.mp4')).toBe('video');
    expect(mediaKind('song.flac')).toBe('audio');
    expect(mediaKind('doc.pdf')).toBe('pdf');
  });

  it('returns null for text and unknown files', () => {
    expect(mediaKind('src/index.ts')).toBeNull();
    expect(mediaKind('README.md')).toBeNull();
    expect(mediaKind('data.bin')).toBeNull();
  });

  it('returns null for dotfiles and extensionless names', () => {
    expect(mediaKind('.gitignore')).toBeNull();
    expect(mediaKind('Makefile')).toBeNull();
    expect(mediaKind('dir.with.dots/LICENSE')).toBeNull();
  });
});
