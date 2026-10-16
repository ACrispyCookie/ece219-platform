export type PreviewKind = 'text' | 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp';
export const TEXT_LIMIT = 1024 * 1024;
export const BINARY_LIMIT = 16 * 1024 * 1024;
export const MAX_RASTER_PIXELS = 10_000_000;
export const MAX_RASTER_DIMENSION = 16384;
const textExtensions = new Set(
  'txt text md markdown json jsonl csv tsv log yaml yml toml ini cfg conf xml html htm svg css scss js jsx mjs cjs ts tsx py ipynb c h cpp hpp cc java rs go rb php sh bash zsh sql v vh sv svh vhd vhdl asm s r tex rst diff patch tcl xdc ucf hex mem'.split(
    ' ',
  ),
);
export function classifyPreview(filename: string): PreviewKind | null {
  const name = filename.split(/[\\/]/).pop()!.toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (ext === 'pdf' || ext === 'png' || ext === 'gif' || ext === 'webp') return ext;
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (
    textExtensions.has(ext) ||
    ['makefile', 'dockerfile', 'readme', 'license', '.gitignore'].includes(name)
  )
    return 'text';
  return null;
}
export const previewLimit = (kind: PreviewKind) => (kind === 'text' ? TEXT_LIMIT : BINARY_LIMIT);

// Only the two inert download contracts are accepted. Never normalize a hostile
// source URL into a valid one, and preserve the exact archive member query.
export function safePreviewURL(url: string): string | null {
  if (/^\/api\/v1\/files\/[A-Za-z0-9_-]+\/download$/.test(url)) return url;
  if (!/^\/api\/v1\/submissions\/[A-Za-z0-9_-]+\/members\/content\?path=[^&#\s]+$/.test(url))
    return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.searchParams.getAll('path').length !== 1 || !parsed.searchParams.get('path'))
      return null;
    return url;
  } catch {
    return null;
  }
}
const tooLarge = () =>
  new Error('Το αρχείο υπερβαίνει το όριο προεπισκόπησης. Χρησιμοποιήστε τη λήψη πρωτοτύπου.');
const aborted = () => new DOMException('Η προεπισκόπηση ακυρώθηκε.', 'AbortError');

export async function readPreviewBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = response.body;
  if (!body) throw new Error('Δεν είναι διαθέσιμη ασφαλής ανάγνωση ροής. Χρησιμοποιήστε τη λήψη.');
  const declared = response.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void body.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal.aborted) throw aborted();
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      if (value.byteLength > limit - length) throw tooLarge();
      length += value.byteLength;
      chunks.push(value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

const invalidFormat = () =>
  new Error('Μη υποστηριζόμενη ή μη έγκυρη μορφή αρχείου. Χρησιμοποιήστε τη λήψη πρωτοτύπου.');
function requireHeader(valid: boolean): asserts valid {
  if (!valid) throw invalidFormat();
}
type RasterSize = { width: number; height: number };
function rasterSize(width: number, height: number): RasterSize {
  // Divide before multiplying: even a hostile unsigned 32-bit header cannot
  // overflow an intermediate product or evade the pixel budget by rounding.
  requireHeader(
    Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width <= MAX_RASTER_DIMENSION &&
      height <= MAX_RASTER_DIMENSION &&
      width <= Math.floor(MAX_RASTER_PIXELS / height),
  );
  return { width, height };
}
function frameWithin(canvas: RasterSize, frame: RasterSize, x = 0, y = 0) {
  requireHeader(x <= canvas.width - frame.width && y <= canvas.height - frame.height);
}
const headerView = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (bytes: Uint8Array, at: number, tag: string) =>
  [...tag].every((char, i) => bytes[at + i] === char.charCodeAt(0));
const uint24 = (bytes: Uint8Array, at: number) =>
  bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;

// Inspect only bounded encoded bytes, never create an image or invoke a decoder.
// These are header/container checks, not pixel-stream or checksum validation.
function validatePNG(bytes: Uint8Array) {
  requireHeader(bytes.length >= 33);
  const view = headerView(bytes);
  requireHeader(view.getUint32(8) === 13 && tagAt(bytes, 12, 'IHDR'));
  const canvas = rasterSize(view.getUint32(16), view.getUint32(20));
  const depth = bytes[24];
  const color = bytes[25];
  requireHeader(
    (color === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
      (color === 3 && [1, 2, 4, 8].includes(depth)) ||
      ([2, 4, 6].includes(color) && [8, 16].includes(depth)),
  );
  requireHeader(bytes[26] === 0 && bytes[27] === 0 && bytes[28] <= 1);
  let declaredFrames = 0;
  let frames = 0;
  let sequence = 0;
  let sawData = false;
  // APNG can carry additional frame dimensions after IHDR. Inspect every
  // control chunk before the browser can encounter any of those frames.
  for (let at = 33; at < bytes.length;) {
    requireHeader(at + 12 <= bytes.length);
    const length = view.getUint32(at);
    requireHeader(length <= bytes.length - at - 12 && !tagAt(bytes, at + 4, 'IHDR'));
    const data = at + 8;
    if (tagAt(bytes, at + 4, 'acTL')) {
      requireHeader(length === 8 && declaredFrames === 0 && !sawData);
      declaredFrames = view.getUint32(data);
      requireHeader(declaredFrames > 0);
    } else if (tagAt(bytes, at + 4, 'fcTL')) {
      requireHeader(length === 26 && declaredFrames > 0 && ++frames <= declaredFrames);
      requireHeader(view.getUint32(data) === sequence++);
      const frame = rasterSize(view.getUint32(data + 4), view.getUint32(data + 8));
      frameWithin(canvas, frame, view.getUint32(data + 12), view.getUint32(data + 16));
      requireHeader(bytes[data + 24] <= 2 && bytes[data + 25] <= 1);
    } else if (tagAt(bytes, at + 4, 'fdAT')) {
      requireHeader(length >= 4 && frames > 0 && view.getUint32(data) === sequence++);
    } else if (tagAt(bytes, at + 4, 'IDAT')) sawData = true;
    else if (tagAt(bytes, at + 4, 'IEND')) {
      requireHeader(
        length === 0 && sawData && frames === declaredFrames && at + 12 === bytes.length,
      );
      return;
    }
    at += length + 12;
  }
  throw invalidFormat();
}

function validateJPEG(bytes: Uint8Array) {
  const view = headerView(bytes);
  let at = 2;
  let components = 0;
  let inScan = false;
  let sawScan = false;
  // Walk marker segments and entropy bytes monotonically within this array.
  // Do not stop at the first SOF: a later SOF/DNL must not redefine its size.
  while (at < bytes.length) {
    if (inScan && bytes[at] !== 0xff) {
      at++;
      continue;
    }
    requireHeader(bytes[at++] === 0xff);
    while (at < bytes.length && bytes[at] === 0xff) at++;
    requireHeader(at < bytes.length);
    const marker = bytes[at++];
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    inScan = false;
    if (marker === 0xd9) {
      requireHeader(components > 0 && sawScan);
      return;
    }
    // Baseline, extended sequential and progressive SOFs are the supported
    // browser JPEG headers. Reject DNL, hierarchical/unknown frame modes.
    const sof = marker >= 0xc0 && marker <= 0xc2;
    requireHeader(
      sof ||
        [0xc4, 0xcc, 0xda, 0xdb, 0xdd, 0xfe].includes(marker) ||
        (marker >= 0xe0 && marker <= 0xef),
    );
    requireHeader(at + 2 <= bytes.length);
    const length = view.getUint16(at);
    requireHeader(length >= 2 && length <= bytes.length - at);
    if (sof) {
      requireHeader(components === 0 && length >= 8);
      const count = bytes[at + 7];
      requireHeader(count >= 1 && count <= 4 && length === 8 + count * 3 && bytes[at + 2] === 8);
      rasterSize(view.getUint16(at + 5), view.getUint16(at + 3));
      components = count;
    } else if (marker === 0xda) {
      requireHeader(components > 0 && length >= 6);
      const count = bytes[at + 2];
      requireHeader(count >= 1 && count <= components && length === 6 + count * 2);
      inScan = true;
      sawScan = true;
    }
    at += length;
  }
  throw invalidFormat();
}

function validateGIF(bytes: Uint8Array) {
  requireHeader(bytes.length >= 13);
  const view = headerView(bytes);
  const canvas = rasterSize(view.getUint16(6, true), view.getUint16(8, true));
  const paletteBytes = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  let at = 13 + paletteBytes(bytes[10]);
  let frames = 0;
  // GIF extensions and image data use bounded sub-blocks terminated by zero.
  const skipBlocks = () => {
    let count = 0;
    while (at < bytes.length) {
      const size = bytes[at++];
      if (size === 0) return count;
      requireHeader(size <= bytes.length - at);
      at += size;
      count++;
    }
    throw invalidFormat();
  };
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3b) {
      requireHeader(frames > 0 && at === bytes.length);
      return;
    }
    if (marker === 0x21) {
      requireHeader(at < bytes.length);
      const label = bytes[at++];
      requireHeader([0xf9, 0xfe, 0xff, 0x01].includes(label));
      if (label === 0xf9) {
        requireHeader(at + 6 <= bytes.length && bytes[at] === 4 && bytes[at + 5] === 0);
        at += 6;
      } else skipBlocks();
      continue;
    }
    requireHeader(marker === 0x2c && at + 9 <= bytes.length);
    const frame = rasterSize(view.getUint16(at + 4, true), view.getUint16(at + 6, true));
    frameWithin(canvas, frame, view.getUint16(at, true), view.getUint16(at + 2, true));
    const flags = bytes[at + 8];
    requireHeader((flags & 0x18) === 0 && ((bytes[10] & 0x80) !== 0 || (flags & 0x80) !== 0));
    at += 9 + paletteBytes(flags);
    requireHeader(at < bytes.length && bytes[at] >= 2 && bytes[at] <= 8);
    at++;
    requireHeader(skipBlocks() > 0);
    frames++;
  }
  throw invalidFormat();
}

type WebPChunk = { type: string; data: Uint8Array };
function* webPChunks(bytes: Uint8Array, start: number): Generator<WebPChunk> {
  const view = headerView(bytes);
  for (let at = start; at < bytes.length;) {
    requireHeader(at + 8 <= bytes.length);
    const size = view.getUint32(at + 4, true);
    const padded = size + (size % 2);
    requireHeader(padded <= bytes.length - at - 8);
    yield {
      type: String.fromCharCode(...bytes.subarray(at, at + 4)),
      data: bytes.subarray(at + 8, at + 8 + size),
    };
    at += 8 + padded;
  }
}
function webPSize(type: string, data: Uint8Array): RasterSize {
  const view = headerView(data);
  if (type === 'VP8 ') {
    requireHeader(
      data.length >= 10 &&
        (data[0] & 1) === 0 &&
        (data[0] & 0x0e) <= 6 &&
        (data[0] & 0x10) !== 0 &&
        tagAt(data, 3, '\x9d\x01\x2a'),
    );
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    requireHeader((width & 0xc000) === 0 && (height & 0xc000) === 0);
    return rasterSize(width, height);
  }
  requireHeader(type === 'VP8L' && data.length >= 5 && data[0] === 0x2f && (data[4] & 0xe0) === 0);
  const bits = view.getUint32(1, true);
  return rasterSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}
function validateWebP(bytes: Uint8Array) {
  requireHeader(bytes.length >= 20 && headerView(bytes).getUint32(4, true) === bytes.length - 8);
  let canvas: RasterSize | undefined;
  let extended = false;
  let animation = false;
  let animationHeader = false;
  let frames = 0;
  for (const { type, data } of webPChunks(bytes, 12)) {
    if (!canvas && type === 'VP8X') {
      requireHeader(
        data.length === 10 &&
          (data[0] & 0xc1) === 0 &&
          data[1] === 0 &&
          data[2] === 0 &&
          data[3] === 0,
      );
      canvas = rasterSize(uint24(data, 4) + 1, uint24(data, 7) + 1);
      extended = true;
      animation = (data[0] & 2) !== 0;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      requireHeader(!animation && frames === 0);
      const size = webPSize(type, data);
      if (canvas) requireHeader(size.width === canvas.width && size.height === canvas.height);
      else canvas = size;
      frames++;
    } else if (type === 'ANIM') {
      requireHeader(animation && !animationHeader && frames === 0 && data.length === 6);
      animationHeader = true;
    } else if (type === 'ANMF') {
      requireHeader(!!canvas && animationHeader && data.length >= 16 && (data[15] & 0xfc) === 0);
      const frame = rasterSize(uint24(data, 6) + 1, uint24(data, 9) + 1);
      frameWithin(canvas, frame, uint24(data, 0) * 2, uint24(data, 3) * 2);
      let images = 0;
      for (const chunk of webPChunks(data, 16)) {
        if (chunk.type === 'ALPH') {
          requireHeader(images === 0 && chunk.data.length > 0);
          continue;
        }
        const size = webPSize(chunk.type, chunk.data);
        requireHeader(images++ === 0 && size.width === frame.width && size.height === frame.height);
      }
      requireHeader(images === 1);
      frames++;
    } else {
      requireHeader(extended && ['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type));
    }
  }
  requireHeader(!!canvas && frames > 0 && (!animation || animationHeader));
}

export function validatePreviewBytes(bytes: Uint8Array, kind: PreviewKind): void {
  const starts = (...signature: number[]) => signature.every((v, i) => bytes[i] === v);
  let valid: boolean;
  switch (kind) {
    case 'png':
      valid = starts(137, 80, 78, 71, 13, 10, 26, 10);
      if (valid) validatePNG(bytes);
      break;
    case 'jpeg':
      valid = starts(255, 216, 255);
      if (valid) validateJPEG(bytes);
      break;
    case 'gif':
      valid = starts(71, 73, 70, 56, 55, 97) || starts(71, 73, 70, 56, 57, 97);
      if (valid) validateGIF(bytes);
      break;
    case 'webp':
      valid =
        starts(82, 73, 70, 70) &&
        bytes[8] === 87 &&
        bytes[9] === 69 &&
        bytes[10] === 66 &&
        bytes[11] === 80;
      if (valid) validateWebP(bytes);
      break;
    case 'pdf':
      valid = starts(37, 80, 68, 70, 45);
      break;
    case 'text': {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        valid = !bytes.includes(0);
      } catch {
        valid = false;
      }
      break;
    }
  }
  if (!valid) throw invalidFormat();
}
export const imageMIME = (kind: Exclude<PreviewKind, 'pdf' | 'text'>) => `image/${kind}`;
