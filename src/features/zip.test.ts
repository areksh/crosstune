import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { crc32, createZip, dosDateTime } from "./zip.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("crc32", () => {
  it("matches the standard check values", () => {
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(text("a"))).toBe(0xe8b7be43);
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(text("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("dosDateTime", () => {
  it("packs a local date into MS-DOS date and time fields", () => {
    // 2026-07-07 13:45:30 local -> seconds are stored halved.
    const { date, time } = dosDateTime(new Date(2026, 6, 7, 13, 45, 30));
    expect(date).toBe(((2026 - 1980) << 9) | (7 << 5) | 7);
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it("clamps dates before 1980 to the format's epoch", () => {
    const { date, time } = dosDateTime(new Date(1970, 0, 1));
    expect(date).toBe((0 << 9) | (1 << 5) | 1);
    expect(time).toBe(0);
  });
});

/** A minimal reader for the archives createZip writes, via the central directory. */
function readZip(zip: Uint8Array): Array<{
  name: string;
  method: number;
  flags: number;
  crc: number;
  data: Uint8Array;
}> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  expect(view.getUint16(eocd + 8, true)).toBe(count);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  expect(cdOffset + cdSize).toBe(eocd);

  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));

    // The local header must agree with the central directory.
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    expect(view.getUint16(localOffset + 8, true)).toBe(method);
    expect(view.getUint32(localOffset + 14, true)).toBe(crc);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtra;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    expect(data.byteLength).toBe(size);
    entries.push({ name, method, flags, crc, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("createZip", () => {
  const when = new Date(2026, 10, 1, 12, 0, 0);

  it("writes an empty archive as a lone end-of-central-directory record", () => {
    const zip = createZip([], { date: when });
    expect(zip.byteLength).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("round-trips entries, deflating those that shrink", () => {
    const long = "Portishead - Roads\n".repeat(200);
    const zip = createZip(
      [
        { name: "Chill.txt", data: text(long) },
        { name: "tiny.txt", data: text("x") },
      ],
      { date: when },
    );
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["Chill.txt", "tiny.txt"]);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe(long);
    expect(entries[0]!.method).toBe(8); // deflated: repetitive text shrinks
    expect(entries[1]!.method).toBe(0); // stored: deflate would not help
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("x");
    for (const entry of entries) {
      expect(entry.crc).toBe(crc32(entry.data));
    }
  });

  it("can store every entry uncompressed", () => {
    const zip = createZip([{ name: "a.txt", data: text("a".repeat(500)) }], {
      date: when,
      compress: false,
    });
    expect(readZip(zip)[0]!.method).toBe(0);
  });

  it("marks names as UTF-8 so non-ASCII playlist names survive", () => {
    const zip = createZip([{ name: "Café Noir.m3u", data: text("#EXTM3U\n") }], { date: when });
    const [entry] = readZip(zip);
    expect(entry!.name).toBe("Café Noir.m3u");
    expect(entry!.flags & 0x0800).toBe(0x0800);
  });
});
