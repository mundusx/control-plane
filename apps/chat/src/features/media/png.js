import { inflateSync } from "node:zlib";
import { httpError } from "../../shared/http-error.js";

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A deliberately narrow output format: static, non-interlaced 8-bit RGB/RGBA PNG.
export function validatePng(bytes, width, height) {
  const fail = () => { throw httpError(422, "Image is not a valid PNG for the reserved dimensions"); };
  if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(SIGNATURE)) fail();
  let offset = 8, channels = 0, ended = false, idatClosed = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) fail();
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail();
    if (offset === 8 && kind !== "IHDR") fail();
    if (kind === "IHDR") {
      if (offset !== 8 || length !== 13 || data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height ||
          data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) fail();
      channels = data[9] === 2 ? 3 : 4;
    } else if (kind === "IDAT") {
      if (idatClosed) fail();
      compressed.push(data);
    } else if (kind === "IEND") {
      if (length || end !== bytes.length || !compressed.length) fail();
      ended = true;
    } else {
      if (compressed.length) idatClosed = true;
      if (!/^[A-Za-z]{4}$/.test(kind) || ["acTL", "fcTL", "fdAT"].includes(kind) ||
          (kind[0] === kind[0].toUpperCase() && kind !== "PLTE")) fail();
    }
    offset = end;
  }
  if (!ended || !channels || width < 1 || height < 1 || width > 4096 || height > 4096) fail();
  const stride = width * channels + 1;
  const expected = stride * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); } catch { fail(); }
  if (raw.length !== expected) fail();
  for (let at = 0; at < raw.length; at += stride) if (raw[at] > 4) fail();
}
