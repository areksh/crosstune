import { describe, expect, it } from "vitest";

import { qid } from "../services/ids.test-support.js";
import { richAccount } from "./world.test-support.js";
import { DEFAULT_TIDY, type Finding, type TidySet } from "./model.js";
import {
  applyFindings,
  dueTidies,
  findTidyFindings,
  screenFindings,
  stillApplies,
  type TidyBook,
} from "./tidy.js";

const NOW = new Date("2026-11-02T06:00:00Z");

const all: TidySet = { ...DEFAULT_TIDY, dedupe: { ...DEFAULT_TIDY.dedupe }, upgrade: { ...DEFAULT_TIDY.upgrade }, repair: { ...DEFAULT_TIDY.repair } };
const emptyBook = (): TidyBook => ({ owned: [], substitutions: [], applied: [], ignored: [], favouriteDates: new Map() });

describe("dueTidies", () => {
  it("runs every-pass ones always and weekly/monthly ones by their last run", () => {
    expect(dueTidies(all, {}, NOW)).toEqual(["repair", "upgrade", "dedupe"]);
    const sixDays = new Date(NOW.getTime() - 6 * 86_400_000).toISOString();
    const sevenDays = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
    expect(dueTidies(all, { repair: { lastRunAt: sixDays }, upgrade: { lastRunAt: sevenDays, checked: [] } }, NOW)).toEqual([
      "dedupe",
    ]);
    expect(dueTidies(all, { repair: { lastRunAt: sevenDays } }, NOW)).toEqual(["repair", "upgrade", "dedupe"]);
    expect(dueTidies({ dedupe: all.dedupe }, {}, NOW)).toEqual(["dedupe"]);
  });
});

describe("findTidyFindings", () => {
  it("finds repairs, upgrades and duplicates with stable keys", async () => {
    const account = richAccount();
    const id = account.seedPlaylist("Mix", [qid(1), qid(3), qid(5), qid(6)]);
    const tracks = await account.getPlaylistTracks(id);
    const result = await findTidyFindings(account, all, ["repair", "upgrade", "dedupe"], { type: "playlist", playlistId: id }, tracks, {
      now: NOW,
      state: {},
      favouriteDates: new Map(),
    });
    expect(result.findings.map((finding) => finding.key)).toEqual(["repair:3", "upgrade:1>2", "dedupe:5,6"]);
    expect(result.findings[2]?.change).toEqual({
      type: "dedupe",
      keepTrackId: qid(5),
      remove: [{ trackId: qid(6), playlistTrackId: tracks[3]?.playlistTrackId }],
    });
    expect(result.checked?.map((entry) => entry.trackId)).toEqual([qid(3), qid(1), qid(5)]);
  });

  it("does not search again for tracks checked recently", async () => {
    const account = richAccount();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    const tracks = await account.getPlaylistTracks(id);
    const result = await findTidyFindings(account, all, ["upgrade"], { type: "playlist", playlistId: id }, tracks, {
      now: NOW,
      state: { upgrade: { lastRunAt: "", checked: [{ trackId: qid(1), at: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() }] } },
      favouriteDates: new Map(),
    });
    expect(result.findings).toEqual([]);
  });
});

describe("screenFindings", () => {
  const finding = (key: string): Finding => ({ key, tidy: "repair", summary: key, change: { type: "remove", trackId: qid(1) } });

  it("drops ignored findings and ignores applied ones found again", () => {
    expect(screenFindings([finding("a"), finding("b"), finding("c")], { ignored: ["a"], applied: ["b"] })).toEqual({
      fresh: [finding("c")],
      newlyIgnored: ["b"],
    });
  });
});

describe("applyFindings on a playlist", () => {
  it("replaces, repairs and de-duplicates, recording substitutions and passing ownership on", async () => {
    const account = richAccount();
    const id = account.seedPlaylist("Mix", [qid(1), qid(3), qid(5), qid(6)]);
    const before = await account.getPlaylistTracks(id);
    const [e1, e3, e5, e6] = before.map((track) => track.playlistTrackId!);
    const target = { type: "playlist" as const, playlistId: id };
    const { findings } = await findTidyFindings(account, all, ["repair", "upgrade", "dedupe"], target, before, {
      now: NOW,
      state: {},
      favouriteDates: new Map(),
    });
    const book = { ...emptyBook(), owned: [{ playlistTrackId: e1!, trackId: qid(1) }, { playlistTrackId: e6!, trackId: qid(6) }] };

    const result = await applyFindings(account, target, findings, before, book);

    expect(account.trackIds(id)).toEqual([qid(2), qid(4), qid(5)]); // replacements moved into place
    expect(result.replaced).toBe(2);
    expect(result.book.substitutions).toEqual([
      { from: qid(3), to: qid(4), key: "repair:3" },
      { from: qid(1), to: qid(2), key: "upgrade:1>2" },
      { from: qid(6), to: qid(5), key: "dedupe:5,6" },
    ]);
    // Track 1's entry was owned, so its replacement is; the removed copy is not.
    expect(result.book.owned).toEqual([{ playlistTrackId: account.entryIds(id)[0], trackId: qid(2) }]);
    expect(e3 !== undefined && e5 !== undefined).toBe(true);
  });

  it("records an exact duplicate's removal as applied", async () => {
    const account = richAccount();
    const id = account.seedPlaylist("Mix", [qid(5), qid(5)]);
    const before = await account.getPlaylistTracks(id);
    const target = { type: "playlist" as const, playlistId: id };
    const { findings } = await findTidyFindings(account, all, ["dedupe"], target, before, { now: NOW, state: {}, favouriteDates: new Map() });
    const result = await applyFindings(account, target, findings, before, emptyBook());
    expect(account.trackIds(id)).toEqual([qid(5)]);
    expect(result.book.applied).toEqual(["dedupe:5,5"]);
    expect(result.book.substitutions).toEqual([]);
  });
});

describe("applyFindings on the favourites", () => {
  it("carries the original favourited date over to the replacement", async () => {
    const account = richAccount({ 1: "2019-05-01T00:00:00.000Z" });
    account.favourites.tracks = [qid(1)];
    const before = await account.getFavoriteTracks();
    const target = { type: "favourites" as const };
    const { findings } = await findTidyFindings(account, all, ["upgrade"], target, before, { now: NOW, state: {}, favouriteDates: new Map() });
    const result = await applyFindings(account, target, findings, before, emptyBook());
    expect(account.favourites.tracks).toEqual([qid(2)]);
    expect([...result.book.favouriteDates]).toEqual([[qid(2), "2019-05-01T00:00:00.000Z"]]);
    expect(result.book.applied).toEqual(["upgrade:1>2"]);
  });

  it("keeps the first-added copy by the carried dates", async () => {
    // 6 was added first; 5 replaced an older favourite today but carries 2018.
    const account = richAccount({ 5: NOW.toISOString(), 6: "2020-01-01T00:00:00.000Z" });
    account.favourites.tracks = [qid(6), qid(5)];
    const before = await account.getFavoriteTracks();
    const tidy: TidySet = { dedupe: { ...DEFAULT_TIDY.dedupe, keep: ["first-added"] } };
    const { findings } = await findTidyFindings(account, tidy, ["dedupe"], { type: "favourites" }, before, {
      now: NOW,
      state: {},
      favouriteDates: new Map([[qid(5), "2018-01-01T00:00:00.000Z"]]),
    });
    expect(findings[0]?.change).toMatchObject({ type: "dedupe", keepTrackId: qid(5) });
  });
});

describe("stillApplies", () => {
  it("is false once the entry is gone", async () => {
    const account = richAccount();
    const id = account.seedPlaylist("Mix", [qid(1)]);
    const tracks = await account.getPlaylistTracks(id);
    const finding: Finding = {
      key: "upgrade:1>2",
      tidy: "upgrade",
      summary: "",
      change: { type: "replace", trackId: qid(1), newTrackId: qid(2), playlistTrackId: tracks[0]!.playlistTrackId! },
    };
    const target = { type: "playlist" as const, playlistId: id };
    expect(stillApplies(finding, target, tracks)).toBe(true);
    expect(stillApplies(finding, target, [])).toBe(false);
  });
});
