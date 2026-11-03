/**
 * Which non-text files render as an inline preview instead of Monaco (SPEC §8):
 * images, video, audio, PDF. Pure and DOM-free so `EditorZone` can branch on it
 * and it stays unit-testable. Extensions mirror the daemon's `MEDIA_MIME` map in
 * `media-mime.ts` — keep the two in step.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf';

const BY_EXT: Record<string, MediaKind> = {
  // images
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  svg: 'image',
  // video
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  // audio
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',
  // documents
  pdf: 'pdf',
};

/** The media kind for a path, or null when it should open as a normal editor. */
export function mediaKind(path: string): MediaKind | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a leading-dot dotfile
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}
