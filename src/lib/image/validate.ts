import { ImageError } from '../errors.js';

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  bytes: number;
}

const MIN_BYTES = 1024;

function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 30) return undefined;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ' && buf.length >= 36) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    if (buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/**
 * Rejects anything that is not a real PNG, JPEG or WebP image of at least
 * 1 KB with readable dimensions. No attempt is made to repair the bytes.
 */
export function validateImageBytes(buf: Buffer): ImageInfo {
  if (buf.length < MIN_BYTES) {
    throw new ImageError('IMAGE_INVALID_BYTES', `Image is only ${buf.length} bytes; expected at least ${MIN_BYTES}.`, {
      bytes: buf.length,
    });
  }

  const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp = buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';

  let mime: ImageInfo['mime'];
  let size: { width: number; height: number } | undefined;
  if (isPng) {
    mime = 'image/png';
    size = pngSize(buf);
  } else if (isJpeg) {
    mime = 'image/jpeg';
    size = jpegSize(buf);
  } else if (isWebp) {
    mime = 'image/webp';
    size = webpSize(buf);
  } else {
    throw new ImageError('IMAGE_INVALID_BYTES', 'Image bytes are not PNG, JPEG or WebP.', {
      bytes: buf.length,
      headHex: buf.subarray(0, 16).toString('hex'),
    });
  }

  if (!size || size.width <= 0 || size.height <= 0) {
    throw new ImageError('IMAGE_INVALID_BYTES', `Image header does not contain readable dimensions (${mime}).`, {
      bytes: buf.length,
      mime,
    });
  }

  return { mime, width: size.width, height: size.height, bytes: buf.length };
}
