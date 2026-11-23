/**
 * Linked playlists in plain words, for the web UI (and anything else that shows
 * them): what a conflict is, what a question asks, what a sync or a fix would
 * write, and how much needs the user. DOM-free, so it is tested.
 */

import type { RunResultSummary } from "../jobs/model.js";
import { SERVICE_LABELS, type ServiceName } from "../services/names.js";
import type { Conflict, LinkState, Question, SongRef } from "./model.js";
import type { CopyChange, CopySide } from "./run.js";
import type { Link, LinksSummary } from "./runner.js";

const label = (service: ServiceName): string => SERVICE_LABELS[service];

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function andList(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function songName(song: SongRef): string {
  return song.artist === undefined || song.artist === "" ? song.title : `${song.title} by ${song.artist}`;
}

/** One sentence per conflict. */
export function describeConflict(conflict: Conflict): string {
  switch (conflict.kind) {
    case "removed-and-changed":
      return `Removed on ${label(conflict.removedOn)} but ${conflict.change === "moved" ? "moved" : "added again"} on ${label(conflict.changedOn)}: ${songName(conflict.song)}.`;
    case "reordered":
      return `Reordered differently on ${andList(conflict.services.map(label))}.`;
    case "renamed":
      return `Renamed differently: ${conflict.names.map((one) => `${one.name} (${label(one.service)})`).join(", ")}.`;
    case "gone":
      return `The ${label(conflict.service)} copy was deleted, or can no longer be read.`;
    case "not-editable":
      return `The ${label(conflict.service)} copy can no longer be edited by you.`;
    case "many-removed":
      return conflict.removed >= conflict.of
        ? `The ${label(conflict.service)} copy was emptied (all ${plural(conflict.of, "song")} removed).`
        : `Many songs were removed from the ${label(conflict.service)} copy (${conflict.removed.toLocaleString("en")} of ${conflict.of.toLocaleString("en")}).`;
    case "interrupted":
      return `A sync was cut off and the ${label(conflict.service)} copy changed meanwhile.`;
    case "first-link":
      return "The copies differ; choose how to start.";
  }
}

/** How a link's conflicts can be settled. */
export type Fix =
  /** A copy is gone or read-only: only unlinking settles it. */
  | { kind: "unlink"; services: ServiceName[] }
  /** Use one copy, or merge; for a first link also start from what they share. */
  | { kind: "choose"; fromCommon: boolean };

export function fixFor(conflicts: readonly Conflict[]): Fix {
  const lost = conflicts.flatMap((conflict) =>
    conflict.kind === "gone" || conflict.kind === "not-editable" ? [conflict.service] : [],
  );
  return lost.length > 0
    ? { kind: "unlink", services: [...new Set(lost)] }
    : { kind: "choose", fromCommon: conflicts.some((conflict) => conflict.kind === "first-link") };
}

/** What a question asks, and why when that helps. */
export function describeQuestion(question: Question): { text: string; detail?: string } {
  switch (question.kind) {
    case "removed-or-withdrawn":
      return {
        text: `Was ${songName(question.song)} removed from ${label(question.service)} by you?`,
        detail: `${label(question.service)} cannot say whether it stopped offering it. Until you answer, the other copies keep it.`,
      };
    case "which-was-removed": {
      const [removed, ...others] = question.songs;
      const name = removed === undefined ? "A song" : songName(removed);
      return {
        text: `${name} was removed from ${label(question.service)}. Remove it from the other copies too?`,
        ...(others.length > 0 && { detail: `There it matches more than one song: ${andList(others.map(songName))}.` }),
      };
    }
    case "match":
      return {
        text: `Which ${label(question.on)} song is ${songName(question.song)}?`,
        ...(question.reason !== undefined && { detail: question.reason }),
      };
    case "repeated":
      return {
        text: `${songName(question.song)} is in the ${label(question.service)} copy more than once, and one of them should go.`,
        detail: `${label(question.service)} can only remove one copy of a repeated song by removing them all and adding the others back.`,
      };
  }
}

/** What a sync or a fix writes to one copy, or would. */
export function describeChange(change: CopyChange | undefined, service: ServiceName): string {
  const parts =
    change === undefined
      ? []
      : [
          ...(change.added > 0 ? [`${plural(change.added, "song")} added`] : []),
          ...(change.removed > 0 ? [`${plural(change.removed, "song")} removed`] : []),
          ...(change.moved ? ["reordered"] : []),
          ...(change.renamed ? ["renamed"] : []),
        ];
  return `${label(service)}: ${parts.length > 0 ? parts.join(", ") : "no change"}`;
}

/** A link's last run. */
export function describeLinkResult(result: RunResultSummary): string {
  if (result.status === "conflict") {
    return "stopped: the copies disagree";
  }
  if (result.status === "failed") {
    return `failed: ${result.error ?? "unknown error"}`;
  }
  const parts = [
    ...(result.added > 0 ? [`${plural(result.added, "song")} added`] : []),
    ...(result.removed > 0 ? [`${plural(result.removed, "song")} removed`] : []),
  ];
  return [`synced: ${parts.length > 0 ? parts.join(", ") : "no changes"}`, ...result.notes].join("; ");
}

/** What running a link (or creating one) did. */
export function describeLinksSummary(summary: LinksSummary): string {
  if (summary.blocked !== undefined) {
    return `Not synced: ${label(summary.blocked.service)} needs you (${summary.blocked.message}).`;
  }
  const report = summary.reports[0];
  if (report === undefined) {
    return "Nothing was synced.";
  }
  const { result } = report;
  switch (result.status) {
    case "conflict":
      return "Not synced: the copies disagree. Choose how to settle it below.";
    case "failed":
      return `Sync failed: ${result.error ?? "unknown error"}.`;
    default: {
      const text = describeLinkResult(result);
      return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    }
  }
}

export interface LinkAttention {
  /** Links whose copies disagree: nothing syncs until the user chooses. */
  conflicted: number;
  /** Songs waiting for an answer, across links. */
  questions: number;
  /** Links with either. */
  links: number;
}

export function linkAttention(links: readonly { state: Pick<LinkState, "conflicts" | "questions"> }[]): LinkAttention {
  return {
    conflicted: links.filter(({ state }) => state.conflicts.length > 0).length,
    questions: links.reduce((sum, { state }) => sum + state.questions.length, 0),
    links: links.filter(({ state }) => state.conflicts.length > 0 || state.questions.length > 0).length,
  };
}

/** The lines above every page while links need the user. */
export function attentionLines(attention: LinkAttention): { text: string; urgent: boolean }[] {
  const { conflicted, questions } = attention;
  return [
    ...(conflicted > 0
      ? [
          {
            text: `${plural(conflicted, "linked playlist")} need${conflicted === 1 ? "s" : ""} you: ${conflicted === 1 ? "its" : "their"} copies disagree, and nothing is synced until you choose.`,
            urgent: true,
          },
        ]
      : []),
    ...(questions > 0
      ? [
          {
            text: `${plural(questions, "song")} in linked playlists ${questions === 1 ? "waits" : "wait"} for your answer; the rest is synced.`,
            urgent: false,
          },
        ]
      : []),
  ];
}

/** The count beside "Managed playlists" in the navigation, if any. */
export function attentionBadge(attention: LinkAttention): { count: number; text: string; urgent: boolean } | undefined {
  return attention.links === 0
    ? undefined
    : { count: attention.links, text: `${attention.links} need you`, urgent: attention.conflicted > 0 };
}

/** How many songs a side names before counting the rest. */
const NAMED = 10;

function songList(songs: readonly SongRef[]): string {
  const names = songs.slice(0, NAMED).map(songName);
  const rest = songs.length - names.length;
  return rest > 0 ? `${names.join(", ")} and ${rest} more` : names.join(", ");
}

/** One copy's column when a conflict's copies are shown side by side. */
export function describeSide(side: CopySide, since: "last-sync" | "in-common"): { title: string; lines: string[] } {
  const title = `${label(side.service)}: ${side.name}, ${plural(side.songs, "song")}`;
  if (since === "in-common") {
    return {
      title,
      lines: [side.added.length === 0 ? "Nothing that the others do not have." : `Only here: ${songList(side.added)}.`],
    };
  }
  const lines = [
    ...(side.renamed ? ["Renamed."] : []),
    ...(side.reordered ? ["Reordered."] : []),
    ...(side.added.length > 0 ? [`Added ${plural(side.added.length, "song")}: ${songList(side.added)}.`] : []),
    ...(side.removed.length > 0 ? [`Removed ${plural(side.removed.length, "song")}: ${songList(side.removed)}.`] : []),
  ];
  return { title, lines: lines.length > 0 ? lines : ["No change since the last sync."] };
}

/** The mark on a playlist that is a copy in a link: loud while its copies disagree. */
export function linkMark(
  playlistId: string,
  links: readonly { link: Pick<Link, "copies">; state: Pick<LinkState, "conflicts"> }[],
): { text: string; conflict: boolean } | undefined {
  const view = links.find(({ link }) => Object.values(link.copies).includes(playlistId as never));
  if (view === undefined) {
    return undefined;
  }
  const others = (Object.keys(view.link.copies) as ServiceName[]).filter((service) => view.link.copies[service] !== playlistId);
  const conflict = view.state.conflicts.length > 0;
  return { text: `Linked with ${andList(others.map(label))}${conflict ? ": the copies disagree" : ""}`, conflict };
}
