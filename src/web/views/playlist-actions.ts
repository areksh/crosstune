/** What the playlists list and the editor share: wording, and dialogs about a playlist. */

import { labelOf } from "../../services/errors.js";
import { serviceOf, shortId, type PlaylistId } from "../../services/ids.js";
import type { ManagerPlaylist } from "../../features/playlist-manager.js";
import { dialogField, openDialog, textInput } from "../dialog.js";
import { routeHash } from "../../ui/routes.js";

/** The page address of a playlist (Qobuz's keep the short form they always had). */
export function playlistHash(id: PlaylistId): string {
  return routeHash({ kind: "playlist", id });
}

/** A playlist as text a tool's link box takes: a link where one is known, else its id. */
export { playlistLink } from "../../ui/tools.js";

export function songCount(count: number): string {
  return `${count.toLocaleString()} song${count === 1 ? "" : "s"}`;
}

/** What editing a managed playlist by hand comes to, or undefined when it is not managed. */
export function managedNotice(playlist: ManagerPlaylist): string | undefined {
  const { managed } = playlist;
  switch (managed?.mode) {
    case undefined:
      return undefined;
    case "mirror":
      return `Managed by "${managed!.jobName}" and kept exactly as its source: its next refresh will undo edits made here.`;
    case "respect":
      return `Managed by "${managed!.jobName}". Songs it added stay out once you remove them; songs you added yourself may come back if its source wants them, and it may move songs.`;
    case "tidy":
      return `"${managed!.jobName}" tidies this playlist on a schedule. Your edits are kept.`;
  }
}

/** Confirm deleting a playlist, saying what hangs on it. */
export function confirmDelete(playlist: ManagerPlaylist): Promise<boolean> {
  const body = [
    playlist.trackCount === undefined
      ? `"${playlist.name}" will be deleted from ${labelOf(serviceOf(playlist.id))}.`
      : `"${playlist.name}" and its ${songCount(playlist.trackCount)} will be deleted from ${labelOf(serviceOf(playlist.id))}.`,
    "Undoing it in History makes it again with the same songs, except any that it no longer plays; links to it will not work any more.",
  ];
  if (playlist.managed !== undefined) {
    body.push(`The managed playlist "${playlist.managed.jobName}" looks after it, and will stop until you decide what it should do.`);
  }
  if (playlist.readBy.length > 0) {
    body.push(`Managed playlists that read from it will lose that source: ${playlist.readBy.join(", ")}.`);
  }
  return openDialog({ title: "Delete this playlist?", body, confirm: "Delete", danger: true });
}

/** Ask for a new name and description; undefined when cancelled or unchanged. */
export async function editDetails(
  playlist: ManagerPlaylist,
): Promise<{ name?: string; description?: string } | undefined> {
  const name = textInput(playlist.name);
  const description = document.createElement("textarea");
  description.rows = 3;
  description.value = playlist.description ?? "";
  const ok = await openDialog({
    title: "Rename and describe",
    body: [dialogField("Name", name), dialogField("Description", description)],
    confirm: "Save",
    validate: () => (name.value.trim() === "" ? "Give it a name." : undefined),
  });
  if (!ok) {
    return undefined;
  }
  const changes: { name?: string; description?: string } = {};
  if (name.value.trim() !== playlist.name) {
    changes.name = name.value.trim();
  }
  if (description.value !== (playlist.description ?? "")) {
    changes.description = description.value;
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}
