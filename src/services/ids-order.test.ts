import { describe, expect, it } from "vitest";

import { compareIds, shortId, tagId } from "./ids.js";

const q = (n: number | string) => tagId<never>("qobuz", n);
const t = (n: number | string) => tagId<never>("tidal", n);

describe("shortId", () => {
  it("is Qobuz's own id, and any other service's id whole", () => {
    expect(shortId(q(12))).toBe("12");
    expect(shortId(t("a:b"))).toBe("tidal:a:b");
  });

  it("leaves what is not an id as it is", () => {
    expect(shortId("x" as never)).toBe("x");
  });
});

describe("compareIds", () => {
  it("orders numbers as numbers, then text, service by service", () => {
    const ids = [t("b"), q(10), t(2), q(9), t("a"), t(10)];
    expect(ids.sort(compareIds)).toEqual(["qobuz:9", "qobuz:10", "tidal:2", "tidal:10", "tidal:a", "tidal:b"]);
  });
});
