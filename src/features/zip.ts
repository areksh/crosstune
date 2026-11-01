/**
 * A minimal ZIP archive writer (no runtime dependencies).
 *
 * Writes the classic (non-ZIP64) format: one local file header plus data per
 * entry, a central directory, and the end-of-central-directory record. Each
 * entry is deflated with `node:zlib` when that makes it smaller, and stored
 * otherwise. Names are flagged as UTF-8 (general purpose bit 11), so playlist
 * names with accents or other scripts survive.
 *
 * It is meant for small, in-memory archives such as "every playlist as its own
 * file"; the classic format's limits (65,535 entries, 4 GiB) are checked.
 */

import { deflateRawSync } from "node:zlib";

/** One file to put in an archive. */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  data: Uint8Array;
}

export interface ZipOptions {
  /** Modification time stamped on every entry (default: now). */
  date?: Date;
  /** Deflate entries that shrink (default true); false stores everything. */
  compress?: boolean;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** General purpose flag: file name (and comment) are UTF-8. */
const FLAG_UTF8 = 0x0800;
/** "Version needed to extract": 2.0 covers deflate. */
const VERSION = 20;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

let crcTable: Uint32Array | undefined;

/** The standard (IEEE 802.3, reflected 0xEDB88320) CRC-32 lookup table. */
function table(): Uint32Array {
  if (crcTable !== undefined) {
    return crcTable;
  }
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** CRC-32 of `data`, as ZIP (and gzip, PNG) use it; an unsigned 32-bit number. */
export function crc32(data: Uint8Array): number {
  const t = table();
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = t[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Pack a date into MS-DOS date and time fields (local time, two-second
 * resolution). Dates before 1980, the format's epoch, clamp to 1980-01-01.
 */
export function dosDateTime(when: Date): { date: number; time: number } {
  if (when.getFullYear() < 1980) {
    return { date: (1 << 5) | 1, time: 0 };
  }
  return {
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
  };
}

/**
 * Build a ZIP archive holding `entries`, in order.
 *
 * @throws {Error} if there are more entries, or an entry or the archive is
 *   larger, than the classic ZIP format can describe.
 */
export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`a ZIP archive holds at most ${MAX_ENTRIES} entries`);
  }
  const { date, time } = dosDateTime(options.date ?? new Date());
  const compress = options.compress ?? true;
  const encoder = new TextEncoder();

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.data.byteLength > MAX_SIZE) {
      throw new Error(`"${entry.name}" is too large for a ZIP archive`);
    }
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    let method = METHOD_STORE;
    let body = entry.data;
    if (compress && entry.data.byteLength > 0) {
      const deflated = new Uint8Array(deflateRawSync(entry.data));
      if (deflated.byteLength < entry.data.byteLength) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.byteLength, true);
    lv.setUint32(22, entry.data.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(name, 30);

    const header = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, CENTRAL_HEADER, true);
    cv.setUint16(4, VERSION, true); // version made by (MS-DOS, 2.0)
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.byteLength, true);
    cv.setUint32(24, entry.data.byteLength, true);
    cv.setUint16(28, name.byteLength, true);
    // extra length, comment length, disk number, internal and external
    // attributes are all zero.
    cv.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, body);
    central.push(header);
    offset += local.byteLength + body.byteLength;
    if (offset > MAX_SIZE) {
      throw new Error("the archive is too large for the ZIP format");
    }
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  // disk numbers stay zero
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  // comment length stays zero

  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
