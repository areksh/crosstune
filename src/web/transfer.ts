/**
 * Sending songs to another service: choose where, review what was found there,
 * then write. Nothing is written before the review, and what the user decides
 * about an uncertain match is remembered by the server.
 */

import type { SongMatch } from "../features/match.js";
import type { Pick, TransferDestination, TransferPlan, TransferResult } from "../features/transfer.js";
import { labelOf } from "../services/errors.js";
import type { PlaylistId, TrackId } from "../services/ids.js";
import type { ServiceName } from "../services/names.js";
import { api, type Track } from "./api.js";
import { openDialog } from "./dialog.js";
import { connectedServices } from "./service.js";

/** Songs to send: as the page holds them, or a whole playlist. */
export type Songs = { tracks: readonly TransferTrack[] } | { playlistId: PlaylistId };
export type TransferTrack = Pick_<Track, "id" | "title" | "version" | "artist" | "isrc" | "album" | "duration"> & {
  other?: "episode" | "video" | "local";
};
type Pick_<T, K extends keyof T> = { [P in K]?: T[P] } & { id: TrackId; title: string };

/** A select of the connected services, or undefined when there is only one. */
export function serviceSelect(chosen: ServiceName): HTMLSelectElement | undefined {
  const services = connectedServices();
  if (services.length < 2) {
    return undefined;
  }
  const select = document.createElement("select");
  for (const service of services) {
    select.append(new Option(labelOf(service), service, false, service === chosen));
  }
  return select;
}

/**
 * Find the songs on `to` and let the user review them. The picks to write, in
 * order; undefined when cancelled.
 */
export async function reviewTransfer(songs: Songs, to: ServiceName): Promise<Pick[] | undefined> {
  const plan = await api<TransferPlan>("POST", "/api/transfer/resolve", {
    to,
    ...("playlistId" in songs ? { playlistId: songs.playlistId } : { tracks: songs.tracks.map(slim) }),
  });
  const likely = plan.matches.filter((match) => match.grade === "likely");
  const missing = plan.matches.filter((match) => match.grade === "missing");
  const picks = new Map<SongMatch, { track: TrackId | null; decided: boolean }>();
  for (const match of plan.matches) {
    picks.set(match, { track: match.grade === "exact" ? match.track!.id : null, decided: false });
  }
  if (likely.length > 0 || missing.length > 0) {
    const ok = await openDialog({
      title: `Review for ${labelOf(to)}`,
      body: [summaryOf(plan), ...(likely.length > 0 ? [likelyList(likely, picks)] : []), ...(missing.length > 0 ? [missingList(missing)] : [])],
      confirm: "Continue",
      wide: true,
      validate: () =>
        [...picks.values()].some((pick) => pick.track !== null) ? undefined : "None of these songs would be copied.",
    });
    if (!ok) {
      return undefined;
    }
  }
  return plan.matches.map((match) => ({ source: match.source.id, ...picks.get(match)! }));
}

/** Write reviewed songs to a destination on `to`. */
export async function sendPicks(to: ServiceName, destination: TransferDestination, picks: readonly Pick[]): Promise<TransferResult> {
  return api<TransferResult>("POST", "/api/transfer/commit", { to, destination, picks });
}

/** "Copied 12 songs to Mix on TIDAL; 2 were left out." */
export function describeTransfer(to: ServiceName, name: string, result: TransferResult): string {
  const many = (n: number): string => `${n} song${n === 1 ? "" : "s"}`;
  const parts = [`Copied ${many(result.added)} to ${name} on ${labelOf(to)}`];
  if (result.leftOut > 0) {
    parts.push(`${result.leftOut} ${result.leftOut === 1 ? "was" : "were"} left out`);
  }
  if (result.missing.length > 0) {
    parts.push(`${labelOf(to)} did not take ${result.missing.length}`);
  }
  return `${parts.join("; ")}.`;
}

/** What matching needs of a song. */
function slim(track: TransferTrack): object {
  const { id, title, version, artist, isrc, album, duration, other } = track;
  return { id, title, version, artist, isrc, album, duration, other };
}

function summaryOf(plan: TransferPlan): HTMLElement {
  const { exact, likely, missing } = plan.counts;
  const line = document.createElement("p");
  line.textContent = [
    `${exact} found exactly`,
    ...(likely > 0 ? [`${likely} to check`] : []),
    ...(missing > 0 ? [`${missing} not found`] : []),
  ].join(", ");
  line.textContent += ".";
  return line;
}

function likelyList(
  matches: readonly SongMatch[],
  picks: Map<SongMatch, { track: TrackId | null; decided: boolean }>,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "transfer-list";
  const heading = document.createElement("h3");
  heading.textContent = "Check these";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Nothing is copied for a song until you choose. Your choice is remembered.";
  box.append(heading, hint);
  for (const match of matches) {
    const row = document.createElement("label");
    row.className = "transfer-row";
    const from = document.createElement("span");
    from.className = "transfer-song";
    from.textContent = songLine(match.source);
    const why = document.createElement("span");
    why.className = "hint";
    why.textContent = match.reason ?? "";
    const select = document.createElement("select");
    select.append(new Option("Choose...", "", true, true), new Option("Leave it out", "none"));
    for (const option of match.options) {
      select.append(new Option(optionLine(option), option.id));
    }
    select.addEventListener("change", () => {
      const value = select.value;
      picks.set(match, value === "" ? { track: null, decided: false } : { track: value === "none" ? null : (value as TrackId), decided: true });
    });
    row.append(from, why, select);
    box.append(row);
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = "secondary small";
  all.textContent = "Take the first suggestion for all";
  all.addEventListener("click", () => {
    box.querySelectorAll("select").forEach((select) => {
      if (select.value === "" && select.options.length > 2) {
        select.selectedIndex = 2;
        select.dispatchEvent(new Event("change"));
      }
    });
  });
  if (matches.length > 1) {
    hint.after(all);
  }
  return box;
}

function missingList(matches: readonly SongMatch[]): HTMLElement {
  const box = document.createElement("details");
  box.className = "transfer-list";
  box.open = matches.length <= 10;
  const summary = document.createElement("summary");
  summary.textContent = `Not found (${matches.length})`;
  const list = document.createElement("ul");
  for (const match of matches) {
    const item = document.createElement("li");
    item.textContent = songLine(match.source);
    const why = document.createElement("span");
    why.className = "hint";
    why.textContent = ` ${match.failed === undefined ? (match.reason ?? "") : `Could not be looked up: ${match.failed}`}`;
    item.append(why);
    list.append(item);
  }
  box.append(summary, list);
  return box;
}

interface Line {
  title: string;
  version?: string;
  artist?: string;
  album?: string;
  duration?: number;
  releaseDate?: string;
}

function songLine(track: Line): string {
  const title = track.version === undefined ? track.title : `${track.title} (${track.version})`;
  return track.artist === undefined ? title : `${title} – ${track.artist}`;
}

function optionLine(track: Line): string {
  const length = track.duration === undefined ? "" : ` (${Math.floor(track.duration / 60)}:${String(Math.round(track.duration % 60)).padStart(2, "0")})`;
  const album = track.album === undefined ? "" : `, ${track.album}`;
  const year = track.releaseDate === undefined ? "" : `, ${track.releaseDate.slice(0, 4)}`;
  return `${songLine(track)}${album}${year}${length}`;
}
