import { describe, expect, it } from 'vitest';
import {
  parsePreviewSrcset,
  previewKind,
  resolvePreviewAsset,
  serialisePreviewSrcset,
} from '../../../src/features/editor/previews/preview-kind';

describe('previewKind', () => {
  it('classifies markdown and html, case-insensitively', () => {
    expect(previewKind('README.md')).toBe('markdown');
    expect(previewKind('docs/guide.MARKDOWN')).toBe('markdown');
    expect(previewKind('notes.mdown')).toBe('markdown');
    expect(previewKind('index.html')).toBe('html');
    expect(previewKind('legacy.HTM')).toBe('html');
  });

  it('returns null for everything else', () => {
    expect(previewKind('src/index.ts')).toBeNull();
    expect(previewKind('photo.png')).toBeNull();
    expect(previewKind('.gitignore')).toBeNull();
    expect(previewKind('Makefile')).toBeNull();
    expect(previewKind('dir.md/plain')).toBeNull(); // directory named like a file
  });
});

describe('resolvePreviewAsset', () => {
  it('resolves plain, ./ and ../ references against the document directory', () => {
    expect(resolvePreviewAsset('docs/guide.md', 'img.png')).toBe('docs/img.png');
    expect(resolvePreviewAsset('docs/guide.md', './img.png')).toBe('docs/img.png');
    expect(resolvePreviewAsset('docs/guide.md', '../shots/a.png')).toBe('shots/a.png');
    expect(resolvePreviewAsset('README.md', 'assets/logo.svg')).toBe('assets/logo.svg');
  });

  it('resolves absolute references from the worktree root', () => {
    expect(resolvePreviewAsset('docs/deep/g.md', '/assets/logo.svg')).toBe('assets/logo.svg');
    expect(resolvePreviewAsset('README.md', '/img.png')).toBe('img.png');
    expect(resolvePreviewAsset('docs/g.md', '/a/../b.png')).toBe('b.png');
  });

  it('strips fragments and query strings', () => {
    expect(resolvePreviewAsset('docs/g.md', 'img.png#frag')).toBe('docs/img.png');
    expect(resolvePreviewAsset('docs/g.md', 'img.png?v=2')).toBe('docs/img.png');
  });

  it('leaves URLs and anchors to the browser', () => {
    expect(resolvePreviewAsset('docs/g.md', 'https://example.com/a.png')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', '//cdn.example.com/a.png')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', 'data:image/png;base64,AAAA')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', 'blob:x')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', 'mailto:a@b.c')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', '#section')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', '')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', '/')).toBeNull();
  });

  it('refuses references escaping the worktree root', () => {
    expect(resolvePreviewAsset('README.md', '../outside.png')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', '../../outside.png')).toBeNull();
    expect(resolvePreviewAsset('docs/g.md', '/../outside.png')).toBeNull();
  });
});

describe('preview srcset', () => {
  it('parses and resolves the theme-aware source used by the Puddle README', () => {
    const [candidate] = parsePreviewSrcset('docs/assets/cockpit-dark.png');
    expect(candidate).toEqual({ ref: 'docs/assets/cockpit-dark.png', descriptor: '' });
    expect(resolvePreviewAsset('README.md', candidate!.ref)).toBe('docs/assets/cockpit-dark.png');
  });

  it('preserves density descriptors and commas inside data URLs', () => {
    const candidates = parsePreviewSrcset(
      'data:image/png;base64,AAAA 1x, docs/assets/cockpit-dark.png 2x',
    );
    expect(candidates).toEqual([
      { ref: 'data:image/png;base64,AAAA', descriptor: '1x' },
      { ref: 'docs/assets/cockpit-dark.png', descriptor: '2x' },
    ]);
    expect(serialisePreviewSrcset(candidates)).toBe(
      'data:image/png;base64,AAAA 1x, docs/assets/cockpit-dark.png 2x',
    );
  });

  it('parses comma-separated candidates without descriptors', () => {
    expect(parsePreviewSrcset('small.png, large.png')).toEqual([
      { ref: 'small.png', descriptor: '' },
      { ref: 'large.png', descriptor: '' },
    ]);
  });
});
