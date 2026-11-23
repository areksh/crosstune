/** How the user registers the app each service asks for. */

import type { ServiceName } from "../../services/names.js";

/** Text, a link, or something to copy ("REDIRECT" is the redirect address). */
export type SetupPart = string | { href: string; text: string } | { code: string };

export interface Setup {
  why: string;
  steps: SetupPart[][];
}

export const SETUP: Partial<Record<ServiceName, Setup>> = {
  tidal: {
    why: "TIDAL asks each person to use an app of their own. Registering one is free.",
    steps: [
      ["Open the ", { href: "https://developer.tidal.com/dashboard", text: "TIDAL developer dashboard" }, ", sign in, and create an app (any name)."],
      ["In the app's settings, add the redirect URI ", { code: "REDIRECT" }, "."],
      [
        "Allow the scopes ",
        { code: "user.read" },
        ", ",
        { code: "collection.read" },
        ", ",
        { code: "collection.write" },
        ", ",
        { code: "playlists.read" },
        ", ",
        { code: "playlists.write" },
        " and ",
        { code: "search.read" },
        ".",
      ],
      ["Copy the app's Client ID here. The client secret is not needed."],
    ],
  },
  spotify: {
    why: "Spotify asks each person to use an app of their own. The account that owns the app needs Spotify Premium.",
    steps: [
      ["Open the ", { href: "https://developer.spotify.com/dashboard", text: "Spotify developer dashboard" }, ", sign in, and create an app (any name)."],
      ["Add the redirect URI ", { code: "REDIRECT" }, " and choose Web API."],
      ["If you will sign in with another account than the one that owns the app, add it under User Management."],
      ["Copy the app's Client ID here. The client secret is not needed."],
    ],
  },
};
