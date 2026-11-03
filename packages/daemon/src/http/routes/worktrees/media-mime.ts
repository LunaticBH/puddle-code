/**
 * Content-types for the inline media viewer (SPEC §8) — image / video / audio /
 * pdf served for in-browser rendering rather than the octet-stream download.
 * Keyed by lower-case extension; anything unlisted falls back to
 * `application/octet-stream` at the route.
 */
const MEDIA_MIME: Record<string, string> = {
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  // documents
  pdf: 'application/pdf',
};

export function mediaMime(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return MEDIA_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}
