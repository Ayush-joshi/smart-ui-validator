import { SmartUiError } from './errors.js';

export interface ImageDimensions {
  width: number;
  height: number;
}

const MAX_SEGMENTS = 1_024;
const MAX_SVG_HEADER_BYTES = 65_536;

/** Bounded dimension parsing for the exact local design formats accepted by Smart UI. */
export function readImageDimensions(
  bytes: Uint8Array,
  mediaType: string,
): ImageDimensions | undefined {
  try {
    const dimensions =
      mediaType === 'image/png'
        ? readPng(bytes)
        : mediaType === 'image/jpeg'
          ? readJpeg(bytes)
          : mediaType === 'image/webp'
            ? readWebp(bytes)
            : mediaType === 'image/svg+xml'
              ? readSvg(bytes)
              : undefined;
    if (!dimensions) return undefined;
    if (
      !Number.isFinite(dimensions.width) ||
      !Number.isFinite(dimensions.height) ||
      dimensions.width <= 0 ||
      dimensions.height <= 0
    ) {
      throw new Error('image dimensions must be positive finite numbers');
    }
    return dimensions;
  } catch (error) {
    throw new SmartUiError(
      'INVALID_INPUT',
      `Could not safely parse ${mediaType} dimensions: ${messageOf(error)}.`,
    );
  }
}

function readPng(bytes: Uint8Array): ImageDimensions | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('invalid PNG signature or truncated IHDR');
  }
  if (ascii(bytes, 12, 16) !== 'IHDR') throw new Error('PNG does not start with IHDR');
  return { width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
}

function readJpeg(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('invalid JPEG start marker');
  }
  let offset = 2;
  for (let count = 0; count < MAX_SEGMENTS && offset < bytes.length; count += 1) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === undefined) break;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error('truncated JPEG segment length');
    const length = readUint16Be(bytes, offset);
    if (length < 2 || offset + length > bytes.length)
      throw new Error('invalid JPEG segment length');
    if (isStartOfFrame(marker)) {
      if (length < 7) throw new Error('truncated JPEG start-of-frame segment');
      return {
        height: readUint16Be(bytes, offset + 3),
        width: readUint16Be(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function readWebp(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') {
    throw new Error('invalid or truncated WebP container');
  }
  const declaredEnd = Math.min(bytes.length, readUint32Le(bytes, 4) + 8);
  let offset = 12;
  for (let count = 0; count < MAX_SEGMENTS && offset + 8 <= declaredEnd; count += 1) {
    const kind = ascii(bytes, offset, offset + 4);
    const length = readUint32Le(bytes, offset + 4);
    const data = offset + 8;
    const end = data + length;
    if (end > declaredEnd || end > bytes.length) throw new Error('invalid WebP chunk length');
    if (kind === 'VP8X') {
      if (length < 10) throw new Error('truncated WebP VP8X header');
      return {
        width: readUint24Le(bytes, data + 4) + 1,
        height: readUint24Le(bytes, data + 7) + 1,
      };
    }
    if (kind === 'VP8 ') {
      if (
        length < 10 ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      ) {
        throw new Error('invalid or truncated WebP VP8 frame header');
      }
      return {
        width: readUint16Le(bytes, data + 6) & 0x3fff,
        height: readUint16Le(bytes, data + 8) & 0x3fff,
      };
    }
    if (kind === 'VP8L') {
      if (length < 5 || bytes[data] !== 0x2f) {
        throw new Error('invalid or truncated WebP VP8L frame header');
      }
      const first = requiredByte(bytes, data + 1);
      const second = requiredByte(bytes, data + 2);
      const third = requiredByte(bytes, data + 3);
      const fourth = requiredByte(bytes, data + 4);
      return {
        width: 1 + ((first | (second << 8)) & 0x3fff),
        height: 1 + (((second >> 6) | (third << 2) | (fourth << 10)) & 0x3fff),
      };
    }
    offset = end + (length % 2);
  }
  return undefined;
}

function readSvg(bytes: Uint8Array): ImageDimensions | undefined {
  const header = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(0, Math.min(bytes.length, MAX_SVG_HEADER_BYTES)),
  );
  const root = /<svg\b[^>]*>/iu.exec(header)?.[0];
  if (!root) throw new Error('SVG root element was not found in the bounded header');
  const width = svgLength(attribute(root, 'width'));
  const height = svgLength(attribute(root, 'height'));
  if (width !== undefined && height !== undefined) return { width, height };
  const viewBox = attribute(root, 'viewBox')
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return { width: viewBox[2] ?? 0, height: viewBox[3] ?? 0 };
  }
  return undefined;
}

function attribute(root: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(root);
  return match?.[2];
}

function svgLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+))(?:px)?$/iu.exec(value.trim());
  return match ? Number(match[1]) : undefined;
}

function isStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
    marker,
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function requiredByte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw new Error('truncated image header');
  return value;
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return (requiredByte(bytes, offset) << 8) | requiredByte(bytes, offset + 1);
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return requiredByte(bytes, offset) | (requiredByte(bytes, offset + 1) << 8);
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return (
    requiredByte(bytes, offset) |
    (requiredByte(bytes, offset + 1) << 8) |
    (requiredByte(bytes, offset + 2) << 16)
  );
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    requiredByte(bytes, offset) * 0x1_00_00_00 +
    (requiredByte(bytes, offset + 1) << 16) +
    (requiredByte(bytes, offset + 2) << 8) +
    requiredByte(bytes, offset + 3)
  );
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    requiredByte(bytes, offset) +
    (requiredByte(bytes, offset + 1) << 8) +
    (requiredByte(bytes, offset + 2) << 16) +
    requiredByte(bytes, offset + 3) * 0x1_00_00_00
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
