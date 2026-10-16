import { describe, expect, it, vi } from 'vitest';
import {
  classifyPreview,
  previewLimit,
  safePreviewURL,
  readPreviewBytes,
  validatePreviewBytes,
  TEXT_LIMIT,
  BINARY_LIMIT,
  MAX_RASTER_PIXELS,
  MAX_RASTER_DIMENSION,
} from '../filePreviewHelpers';

// Complete encoded 2x2 images produced by FFmpeg, plus a complete 1x1 GIF
// (two-entry palette and a clear/pixel/end LZW stream). No browser decoder or
// image allocation is used by these tests. Boundary cases mutate header fields
// of these real containers; they intentionally do not re-encode pixel payloads.
const encodedImages = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==',
  jpeg: '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z',
  webpLossy:
    'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=',
  webpLossless: 'UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ9Y/+ByKi/wEA',
  webpExtended:
    'UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAf39/fwBWUDggMAAAANABAJ0BKgIAAgACADQloAJ0ugH4AAOwAP7w6Pf/ILlhdcjX/yA/5Af8gP/48gAAAA==',
};
type Fixture = keyof typeof encodedImages | 'gif';
const variants = ['png', 'jpeg', 'gif', 'webpLossy', 'webpLossless', 'webpExtended'] as const;
const kindOf = (name: Fixture) =>
  name.startsWith('webp') ? 'webp' : (name as 'png' | 'jpeg' | 'gif');
function image(name: Fixture): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    name === 'gif'
      ? Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex')
      : Buffer.from(encodedImages[name], 'base64'),
  );
}
const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const sofOffset = (bytes: Uint8Array) => Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xc0]));
function chunkOffset(bytes: Uint8Array, type: string): number {
  for (let at = 12; at + 8 <= bytes.length;) {
    if (Buffer.from(bytes.subarray(at, at + 4)).toString('ascii') === type) return at;
    const size = viewOf(bytes).getUint32(at + 4, true);
    at += 8 + size + (size % 2);
  }
  throw new Error(`Missing fixture chunk ${type}`);
}
function set24(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = value & 255;
  bytes[at + 1] = (value >>> 8) & 255;
  bytes[at + 2] = (value >>> 16) & 255;
}
function withDimensions(name: Fixture, width: number, height: number) {
  const bytes = image(name);
  const view = viewOf(bytes);
  if (name === 'png') {
    view.setUint32(16, width);
    view.setUint32(20, height);
  } else if (name === 'jpeg') {
    view.setUint16(sofOffset(bytes) + 5, height);
    view.setUint16(sofOffset(bytes) + 7, width);
  } else if (name === 'gif') {
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
    view.setUint16(24, width, true);
    view.setUint16(26, height, true);
  } else if (name === 'webpLossless') {
    view.setUint32(21, width - 1 + (height - 1) * 16384, true);
  } else {
    if (name === 'webpExtended') {
      set24(bytes, 24, width - 1);
      set24(bytes, 27, height - 1);
    }
    const at = chunkOffset(bytes, 'VP8 ');
    view.setUint16(at + 14, width, true);
    view.setUint16(at + 16, height, true);
  }
  return bytes;
}
function pngChunk(type: string, payload: Uint8Array) {
  const bytes = new Uint8Array(12 + payload.length);
  const view = viewOf(bytes);
  view.setUint32(0, payload.length);
  bytes.set(Buffer.from(type), 4);
  bytes.set(payload, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}
function animatedPNG(control?: Uint8Array) {
  const bytes = image('png');
  const animation = new Uint8Array(8);
  viewOf(animation).setUint32(0, 1);
  const frame = control ?? new Uint8Array(26);
  if (!control) {
    viewOf(frame).setUint32(4, 2);
    viewOf(frame).setUint32(8, 2);
    viewOf(frame).setUint16(20, 1);
    viewOf(frame).setUint16(22, 10);
  }
  return new Uint8Array(
    Buffer.concat([
      bytes.subarray(0, 33),
      pngChunk('acTL', animation),
      pngChunk('fcTL', frame),
      bytes.subarray(33),
    ]),
  );
}

function riffChunk(type: string, payload: Uint8Array) {
  const bytes = new Uint8Array(8 + payload.length + (payload.length % 2));
  bytes.set(Buffer.from(type));
  viewOf(bytes).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}
function animatedWebP(width = 2, height = 2) {
  const canvas = new Uint8Array(10);
  canvas[0] = 2;
  set24(canvas, 4, width - 1);
  set24(canvas, 7, height - 1);
  const frameHeader = new Uint8Array(16);
  set24(frameHeader, 6, 1);
  set24(frameHeader, 9, 1);
  const frame = Buffer.concat([frameHeader, image('webpLossy').subarray(12)]);
  const payload = Buffer.concat([
    Buffer.from('WEBP'),
    riffChunk('VP8X', canvas),
    riffChunk('ANIM', new Uint8Array(6)),
    riffChunk('ANMF', frame),
  ]);
  const bytes = new Uint8Array(8 + payload.length);
  bytes.set(Buffer.from('RIFF'));
  viewOf(bytes).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

describe('preview trust and resource boundaries', () => {
  it.each([
    'x.pdf',
    'X.PNG',
    'x.jpeg',
    'x.gif',
    'x.webp',
    'main.py',
    'x.md',
    'x.html',
    'x.svg',
    'Makefile',
    'x.v',
    'x.asm',
  ])('recognizes allowlisted filename %s', (filename) =>
    expect(classifyPreview(filename)).not.toBeNull(),
  );
  it.each(['x.zip', 'x.docx', 'x.exe', 'x', 'x.png.html.exe'])(
    'never guesses unsupported content %s from MIME',
    (filename) => expect(classifyPreview(filename)).toBeNull(),
  );
  it('assigns separate 1MiB text and 16MiB binary limits', () => {
    expect(TEXT_LIMIT).toBe(1048576);
    expect(BINARY_LIMIT).toBe(16777216);
    expect(previewLimit('text')).toBe(TEXT_LIMIT);
    expect(previewLimit('pdf')).toBe(BINARY_LIMIT);
  });
  it.each([
    '/api/v1/files/id/download',
    '/api/v1/submissions/id/members/content?path=a%2Fb%20c.txt',
  ])('preserves exact authenticated URL %s', (url) => expect(safePreviewURL(url)).toBe(url));
  it.each([
    '//evil.test/api/v1/files/id/download',
    'javascript:alert(1)',
    '/api/v1/files/id/download?x=1',
    '/api/v1/session',
    '/api/v1/files/../download',
    '/api/v1/files/a%2fb/download',
    '/api/v1/submissions/id/members/content?path=x&other=y',
    '/api/v1/submissions/id/members/content?path=x&path=y',
  ])('rejects unsafe URL %s', (url) => expect(safePreviewURL(url)).toBeNull());
  it('streams up to exact cap and releases its reader', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    expect(await readPreviewBytes(new Response(stream), 3, new AbortController().signal)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(stream.locked).toBe(false);
  });
  it('cancels at a lying/missing Content-Length actual cap before retaining extra bytes', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    await expect(
      readPreviewBytes(
        new Response(stream, { headers: { 'Content-Length': '1' } }),
        3,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/όριο/);
    expect(cancel).toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
  it('rejects declared oversize without reading or buffering the body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(
      readPreviewBytes(
        new Response(stream, { headers: { 'Content-Length': '999' } }),
        3,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/όριο/);
    expect(cancel).toHaveBeenCalled();
  });
  it('cancels a hanging reader on abort and releases the lock', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const control = new AbortController();
    const promise = readPreviewBytes(new Response(stream), 3, control.signal);
    control.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
  it.each(['png', 'jpeg', 'gif', 'webp', 'pdf'] as const)(
    'rejects HTML masquerading as %s',
    (kind) =>
      expect(() =>
        validatePreviewBytes(new TextEncoder().encode('<script>alert(1)</script>'), kind),
      ).toThrow(/μορφή/),
  );
  it('preserves the PDF signature check', () => {
    expect(() => validatePreviewBytes(new TextEncoder().encode('%PDF-1.7'), 'pdf')).not.toThrow();
  });
  it('rejects binary NUL and invalid UTF8 in text instead of showing corrupt code', () => {
    expect(() => validatePreviewBytes(new Uint8Array([0]), 'text')).toThrow();
    expect(() => validatePreviewBytes(new Uint8Array([255]), 'text')).toThrow();
  });
});

describe('raster dimensions are bounded before any browser decode', () => {
  it('sets explicit 10-million-pixel and 16384-axis limits', () => {
    expect(MAX_RASTER_PIXELS).toBe(10_000_000);
    expect(MAX_RASTER_DIMENSION).toBe(16384);
  });
  it.each(variants)('accepts a complete small encoded %s', (name) => {
    expect(() => validatePreviewBytes(image(name), kindOf(name))).not.toThrow();
  });
  it.each(variants)('rejects every truncated %s dimension header', (name) => {
    const headerEnd = {
      png: 33,
      jpeg: sofOffset(image('jpeg')) + 19,
      gif: 13,
      webpLossy: 30,
      webpLossless: 25,
      webpExtended: 30,
    }[name];
    for (let length = 0; length < headerEnd; length++) {
      expect(
        () => validatePreviewBytes(image(name).subarray(0, length), kindOf(name)),
        `${name}: ${length} bytes`,
      ).toThrow(/μορφή/);
    }
  });
  it.each(variants)('accepts the exact pixel cap in %s header fields', (name) => {
    expect(() =>
      validatePreviewBytes(withDimensions(name, 4000, 2500), kindOf(name)),
    ).not.toThrow();
  });
  it.each(variants)('rejects one row beyond the pixel cap in %s', (name) => {
    expect(() => validatePreviewBytes(withDimensions(name, 4000, 2501), kindOf(name))).toThrow();
    expect(() => validatePreviewBytes(withDimensions(name, 2501, 4000), kindOf(name))).toThrow();
  });
  it.each(['png', 'jpeg', 'gif', 'webpLossless'] as const)(
    'accepts exactly 16384 on either %s axis',
    (name) => {
      expect(() =>
        validatePreviewBytes(withDimensions(name, 16384, 1), kindOf(name)),
      ).not.toThrow();
      expect(() =>
        validatePreviewBytes(withDimensions(name, 1, 16384), kindOf(name)),
      ).not.toThrow();
    },
  );
  it.each(['png', 'jpeg', 'gif'] as const)('rejects zero or oversized %s axes', (name) => {
    for (const [w, h] of [
      [0, 1],
      [1, 0],
      [16385, 1],
      [1, 16385],
      [65535, 65535],
    ]) {
      expect(() => validatePreviewBytes(withDimensions(name, w, h), kindOf(name))).toThrow();
    }
  });
  it('does not overflow unsigned PNG or 24-bit WebP dimensions', () => {
    expect(() =>
      validatePreviewBytes(withDimensions('png', 0xffffffff, 0xffffffff), 'png'),
    ).toThrow();
    const bytes = image('webpExtended');
    bytes.fill(255, 24, 30);
    expect(() => validatePreviewBytes(bytes, 'webp')).toThrow();
    set24(bytes, 24, 16384);
    set24(bytes, 27, 0);
    expect(() => validatePreviewBytes(bytes, 'webp')).toThrow();
  });
  it.each([
    ['wrong IHDR length', 11, 12],
    ['wrong first chunk', 12, 74],
    ['invalid bit depth', 24, 3],
    ['invalid color type', 25, 1],
    ['unknown compression', 26, 1],
    ['unknown filter', 27, 1],
    ['unknown interlace', 28, 2],
  ] as const)('rejects PNG %s', (_name, at, value) => {
    const bytes = image('png');
    bytes[at] = value;
    expect(() => validatePreviewBytes(bytes, 'png')).toThrow(/μορφή/);
  });
  it('checks PNG chunk boundaries and APNG frame headers, not only IHDR', () => {
    expect(() => validatePreviewBytes(animatedPNG(), 'png')).not.toThrow();
    const bytes = image('png');
    expect(() => validatePreviewBytes(bytes.subarray(0, 33), 'png')).toThrow(/μορφή/);
    expect(() => validatePreviewBytes(bytes.subarray(0, -1), 'png')).toThrow(/μορφή/);
    expect(() =>
      validatePreviewBytes(
        new Uint8Array(Buffer.concat([bytes.subarray(0, 33), bytes.subarray(8)])),
        'png',
      ),
    ).toThrow(/μορφή/);
    expect(() => validatePreviewBytes(animatedPNG(new Uint8Array(25)), 'png')).toThrow(/μορφή/);
    for (const [field, value] of [
      [4, 0],
      [4, 0xffffffff],
      [8, 0xffffffff],
      [12, 1],
      [16, 1],
    ]) {
      const frame = new Uint8Array(26);
      viewOf(frame).setUint32(4, 2);
      viewOf(frame).setUint32(8, 2);
      viewOf(frame).setUint32(field, value);
      expect(() => validatePreviewBytes(animatedPNG(frame), 'png')).toThrow(/μορφή/);
    }
  });
  it.each([0xc0, 0xc1, 0xc2])('reads JPEG SOF marker %s rather than a fixed offset', (marker) => {
    const bytes = image('jpeg');
    bytes[sofOffset(bytes) + 1] = marker;
    expect(() => validatePreviewBytes(bytes, 'jpeg')).not.toThrow();
  });
  it.each([
    'short segment',
    'overlong segment',
    'bad SOF length',
    'bad components',
    'missing SOF',
    'DNL',
  ])('rejects malformed JPEG %s', (name) => {
    const bytes = image('jpeg');
    const at = sofOffset(bytes);
    if (name === 'short segment') viewOf(bytes).setUint16(4, 1);
    if (name === 'overlong segment') viewOf(bytes).setUint16(4, 65535);
    if (name === 'bad SOF length') viewOf(bytes).setUint16(at + 2, 8);
    if (name === 'bad components') bytes[at + 9] = 0;
    if (name === 'missing SOF') bytes[at + 1] = 0xc4;
    if (name === 'DNL') bytes[at + 1] = 0xdc;
    expect(() => validatePreviewBytes(bytes, 'jpeg')).toThrow(/μορφή/);
  });
  it('rejects a second JPEG SOF rather than trusting the first small dimensions', () => {
    const bytes = image('jpeg');
    const at = sofOffset(bytes);
    const large = withDimensions('jpeg', 65535, 65535).subarray(at, at + 19);
    expect(() =>
      validatePreviewBytes(
        new Uint8Array(Buffer.concat([bytes.subarray(0, at + 19), large, bytes.subarray(at + 19)])),
        'jpeg',
      ),
    ).toThrow();
  });
  it('respects typed-array offsets without reading adjacent backing bytes', () => {
    const source = image('jpeg');
    const padded = new Uint8Array(source.length + 4);
    padded.set(source, 2);
    expect(() => validatePreviewBytes(padded.subarray(2, -2), 'jpeg')).not.toThrow();
  });
  it.each([
    'large frame',
    'outside canvas',
    'zero frame',
    'missing descriptor',
    'truncated palette',
    'truncated data',
  ])('rejects GIF %s even with a small logical screen', (name) => {
    let bytes = image('gif');
    if (name === 'large frame') viewOf(bytes).setUint16(24, 65535, true);
    if (name === 'outside canvas') viewOf(bytes).setUint16(20, 1, true);
    if (name === 'zero frame') viewOf(bytes).setUint16(24, 0, true);
    if (name === 'missing descriptor') bytes[19] = 0x3b;
    if (name === 'truncated palette') bytes[10] = 0x87;
    if (name === 'truncated data') bytes = bytes.subarray(0, bytes.length - 2);
    expect(() => validatePreviewBytes(bytes, 'gif')).toThrow(/μορφή/);
  });
  it('checks later GIF frame descriptors, not only the first frame', () => {
    const bytes = image('gif');
    const second = bytes.slice(19, -1);
    viewOf(second).setUint16(5, 65535, true);
    expect(() =>
      validatePreviewBytes(
        new Uint8Array(Buffer.concat([bytes.subarray(0, -1), second, bytes.subarray(-1)])),
        'gif',
      ),
    ).toThrow();
  });
  it.each([
    'bad RIFF size',
    'unknown image header',
    'overlong chunk',
    'non-keyframe',
    'bad VP8 signature',
    'VP8 version',
    'hidden VP8 frame',
    'scaled VP8 dimensions',
    'zero VP8 width',
    'VP8L version',
    'VP8X length',
    'VP8X reserved',
    'canvas mismatch',
  ])('rejects WebP %s', (name) => {
    const bytes = image(
      name.startsWith('VP8L')
        ? 'webpLossless'
        : name.startsWith('VP8X') || name === 'canvas mismatch'
          ? 'webpExtended'
          : 'webpLossy',
    );
    if (name === 'bad RIFF size') viewOf(bytes).setUint32(4, 0xffffffff, true);
    if (name === 'unknown image header') bytes[12] = 88;
    if (name === 'overlong chunk') viewOf(bytes).setUint32(16, 0xffffffff, true);
    if (name === 'non-keyframe') bytes[20] |= 1;
    if (name === 'bad VP8 signature') bytes[23] = 0;
    if (name === 'VP8 version') bytes[20] |= 0x0e;
    if (name === 'hidden VP8 frame') bytes[20] &= ~0x10;
    if (name === 'scaled VP8 dimensions') bytes[27] |= 0x40;
    if (name === 'zero VP8 width') viewOf(bytes).setUint16(26, 0, true);
    if (name === 'VP8L version') bytes[24] |= 0x20;
    if (name === 'VP8X length') viewOf(bytes).setUint32(16, 9, true);
    if (name === 'VP8X reserved') bytes[21] = 1;
    if (name === 'canvas mismatch') set24(bytes, 24, 0);
    expect(() => validatePreviewBytes(bytes, 'webp')).toThrow(/μορφή/);
  });
  it('validates a WebP animation canvas and every frame rectangle/bitstream header', () => {
    expect(() => validatePreviewBytes(animatedWebP(), 'webp')).not.toThrow();
    expect(() => validatePreviewBytes(animatedWebP(16385, 2), 'webp')).toThrow();
    for (const offset of [0, 6, 9]) {
      const bytes = animatedWebP();
      const frame = chunkOffset(bytes, 'ANMF') + 8;
      set24(bytes, frame + offset, 20000);
      expect(() => validatePreviewBytes(bytes, 'webp')).toThrow();
    }
    const mismatch = animatedWebP();
    set24(mismatch, chunkOffset(mismatch, 'ANMF') + 14, 0);
    expect(() => validatePreviewBytes(mismatch, 'webp')).toThrow();
  });
  it('retains escaped-text classification for HTML/SVG instead of treating them as rasters', () => {
    for (const name of ['upload.html', 'upload.svg']) {
      expect(classifyPreview(name)).toBe('text');
      expect(() =>
        validatePreviewBytes(new TextEncoder().encode('<svg onload="alert(1)"/>'), 'text'),
      ).not.toThrow();
    }
  });
});
