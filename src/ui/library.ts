/**
 * What the page's sidebar shows: the service tabs, the playlists under the
 * chosen tab, and the Library rows (Favourites and All playlists per service,
 * New releases once). A linked playlist is one row per copy, each on its own
 * service (see docs/superpowers/specs/2026-11-23-ui-redesign-design.md).
 */

import type { ManagerPlaylist } from "../features/playlist-manager.js";
import { serviceOf, type PlaylistId } from "../services/ids.js";
import type { ServiceName } from "../services/names.js";

export type Tab = ServiceName | "all";

export function tabsFor(connected: readonly ServiceName[]): Tab[] {
  return connected.length > 1 ? ["all", ...connected] : [...connected];
}

/** The tab to show: the remembered one if it is still offered, else the first. */
export function validTab(remembered: string | undefined, connected: readonly ServiceName[]): Tab {
  const tabs = tabsFor(connected);
  return tabs.find((tab) => tab === remembered) ?? tabs[0] ?? "all";
}

export interface SidebarRow {
  id: PlaylistId;
  name: string;
  service: ServiceName;
  trackCount?: number;
  linked: boolean;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** The playlists under a tab matching the filter, the most recently changed first. */
export function sidebarRows(
  playlists: readonly ManagerPlaylist[],
  options: { tab: Tab; filter: string; linked: ReadonlySet<PlaylistId> },
): SidebarRow[] {
  const filter = options.filter.trim().toLowerCase();
  return playlists
    .filter((playlist) => options.tab === "all" || serviceOf(playlist.id) === options.tab)
    .filter((playlist) => playlist.name.toLowerCase().includes(filter))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || byName(a, b))
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      service: serviceOf(playlist.id),
      ...(playlist.trackCount !== undefined && { trackCount: playlist.trackCount }),
      linked: options.linked.has(playlist.id),
    }));
}

export type LibraryRow =
  | { kind: "favourites"; service: ServiceName }
  | { kind: "all"; service: ServiceName }
  | { kind: "new-releases" };

export function libraryRows(connected: readonly ServiceName[], tab: Tab): LibraryRow[] {
  const services = tab === "all" ? connected : connected.filter((service) => service === tab);
  if (services.length === 0) {
    return [];
  }
  return [
    ...services.map((service): LibraryRow => ({ kind: "favourites", service })),
    ...services.map((service): LibraryRow => ({ kind: "all", service })),
    { kind: "new-releases" },
  ];
}
