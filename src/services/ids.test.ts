import { describe, expect, it } from "vitest";

import { checkAllOn, nativeOf, parseId, readAlbumId, readId, serviceOf, tagId } from "./ids.js";
import { ServiceError } from "./errors.js";

describe("tagId", () => {
  it("puts the service before the native id", () => {
    expect(tagId("qobuz", 12)).toBe("qobuz:12");
    expect(tagId("spotify", "4uLU6hMCjMI75M1A2tKUQC")).toBe("spotify:4uLU6hMCjMI75M1A2tKUQC");
  });

  it("refuses an empty native id", () => {
    expect(() => tagId("tidal", "")).toThrow(ServiceError);
  });
});

describe("parseId", () => {
  it("splits at the first colon only, as native ids are opaque", () => {
    expect(parseId("tidal:a:b")).toEqual({ service: "tidal", native: "a:b" });
  });

  it.each(["qobuz:", "nope:1", "12", "", ":1", "Qobuz:1"])("rejects %j", (text) => {
    expect(parseId(text)).toBeUndefined();
  });
});

describe("serviceOf and nativeOf", () => {
  it("read the parts of an id", () => {
    expect(serviceOf(tagId("tidal", "x"))).toBe("tidal");
    expect(nativeOf("tidal", tagId("tidal", "x"))).toBe("x");
  });

  it("refuse an id that is not one", () => {
    expect(() => serviceOf("12" as never)).toThrow(ServiceError);
  });

  it("refuse another service's id, naming both", () => {
    expect(() => nativeOf("qobuz", tagId("tidal", "1"))).toThrow(/tidal:1.*Qobuz/);
  });
});

describe("readId", () => {
  it("takes a tagged id as it is", () => {
    expect(readId("tidal:x")).toBe("tidal:x");
  });

  it("takes a bare number, as older files and links hold, as Qobuz's", () => {
    expect(readId(12)).toBe("qobuz:12");
    expect(readId("12")).toBe("qobuz:12");
  });

  it.each([0, -1, 12.5, "0", "012", "-3", "", "qobuz:", "nope:1", "abc", null, undefined, {}, 2 ** 60])(
    "rejects %j",
    (value) => {
      expect(readId(value)).toBeUndefined();
    },
  );
});

describe("readAlbumId", () => {
  it("takes a bare string as Qobuz's, leading zeros kept", () => {
    expect(readAlbumId("0060254735156")).toBe("qobuz:0060254735156");
    expect(readAlbumId("pvsb64n704d0b")).toBe("qobuz:pvsb64n704d0b");
  });

  it("takes a tagged id as it is", () => {
    expect(readAlbumId("tidal:99")).toBe("tidal:99");
  });

  it.each(["", "qobuz:", "nope:1", "a b", 12, null])("rejects %j", (value) => {
    expect(readAlbumId(value)).toBeUndefined();
  });
});

describe("Qobuz ids from outside", () => {
  it.each(["qobuz:1e2", "qobuz:0x64", "qobuz: 100", "qobuz:0100", "qobuz:100.0", "qobuz:abc", "qobuz:-1"])(
    "rejects %j, which is not how Qobuz writes one",
    (id) => {
      expect(readId(id)).toBeUndefined();
    },
  );

  it.each(["qobuz:a b", "qobuz:a/b", "qobuz:a:b"])("rejects the album id %j", (id) => {
    expect(readAlbumId(id)).toBeUndefined();
  });
});

describe("checkAllOn", () => {
  it("passes ids of the client's service, and checks nothing for a client without a name", () => {
    expect(() => checkAllOn({ name: "qobuz" }, [tagId("qobuz", 1)])).not.toThrow();
    expect(() => checkAllOn({}, [tagId("tidal", 1)])).not.toThrow();
  });

  it("refuses another service's", () => {
    expect(() => checkAllOn({ name: "qobuz" }, [tagId("qobuz", 1), tagId("tidal", 1)])).toThrow(/tidal:1/);
  });
});
