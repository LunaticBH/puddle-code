/**
 * The Settings Sync codec (SPEC §11): turn a machine-agnostic settings object
 * into one opaque, portable string and back. The pipeline is
 *
 *   JSON → gzip → base64 → + CRC-32(gzip) → random Caesar shift
 *
 * over a fixed alphabet. gzip+base64 always begins with `H` (the gzip magic
 * `1f 8b 08` base64s to `H4sI…`), so the decoder maps the received first char
 * back to `H` to recover the shift — no marker needed — then verifies the CRC
 * before decompressing. Result: a jumbled blob that round-trips exactly and
 * detects corruption.
 */

// Base64 chars + '=' padding; every byte of the (base64 + hex-CRC) payload is in
// here, and the caesar shift stays within it.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const N = ALPHABET.length;
const INDEX: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));
const GZIP_B64_FIRST = 'H'; // base64 of the gzip magic byte 0x1f

// --- CRC-32 (integrity check over the gzip bytes) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Hex(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

// --- bytes ⇄ base64 (standard alphabet, matches ALPHABET) ---
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

// --- gzip via the platform CompressionStream (async) ---
async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function caesar(s: string, shift: number): string {
  const k = ((shift % N) + N) % N;
  let out = '';
  for (const ch of s) {
    const i = INDEX[ch];
    out += i === undefined ? ch : ALPHABET[(i + k) % N];
  }
  return out;
}

/** Encode a settings object into the portable sync string. */
export async function encodeSettings(obj: unknown): Promise<string> {
  const gz = await gzip(JSON.stringify(obj));
  const payload = bytesToBase64(gz) + crc32Hex(gz); // base64(gzip) + 8-hex CRC
  // A random non-zero shift; the decoder derives it from the known 'H' anchor.
  const shift = 1 + Math.floor(Math.random() * (N - 1));
  return caesar(payload, shift);
}

/** Decode a sync string, verifying the CRC. Throws on a malformed/corrupt blob. */
export async function decodeSettings(blob: string): Promise<unknown> {
  const trimmed = blob.trim();
  const first = trimmed[0];
  if (!first || INDEX[first] === undefined) throw new Error('Not a settings export.');
  // The pre-shift first char is always 'H' (gzip+base64 magic); recover the shift.
  const shift = (INDEX[first]! - INDEX[GZIP_B64_FIRST]! + N) % N;
  const payload = caesar(trimmed, -shift);
  if (payload.length < 9 || payload[0] !== GZIP_B64_FIRST) {
    throw new Error('Not a settings export.');
  }
  const b64 = payload.slice(0, -8);
  const crc = payload.slice(-8);
  const gz = base64ToBytes(b64);
  if (crc32Hex(gz) !== crc) throw new Error('Settings export is corrupt (checksum mismatch).');
  return JSON.parse(await gunzip(gz));
}
