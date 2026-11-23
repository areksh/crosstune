/**
 * A cover drawn from a name, for when there is no artwork to show: artwork is
 * off by default (ADR-0004), and playlists may have none. The same name always
 * gets the same colours, near names get different ones, and nothing leaves the
 * machine. The playlist header's glow is taken from the same colours.
 */

export interface GeneratedCover {
  /** The base hue, 0-359. */
  hue: number;
  /** Three CSS `hsl()` colours of one family: the light main one, a neighbour, a dark one. */
  colours: [string, string, string];
}

/** FNV-1a over the UTF-16 code units, then murmur3's finaliser so near inputs scatter. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hsl(hue: number, saturation: number, lightness: number, alpha?: number): string {
  const base = `${hue % 360} ${saturation}% ${lightness}%`;
  return alpha === undefined ? `hsl(${base})` : `hsl(${base} / ${alpha})`;
}

export function generatedCover(seed: string): GeneratedCover {
  const hue = hash(seed.trim().toLowerCase()) % 360;
  return {
    hue,
    colours: [hsl(hue, 78, 64), hsl(hue + 30, 80, 56), hsl(hue + 60, 60, 34)],
  };
}

/** A square cover's CSS background. */
export function coverBackground(cover: GeneratedCover): string {
  const [a, b, c] = cover.colours;
  return `conic-gradient(from 210deg at 30% 30%, ${a}, ${b}, ${c}, ${a})`;
}

/** The playlist header's tint, fading into the page. */
export function glowBackground(cover: GeneratedCover): string {
  const { hue } = cover;
  return `radial-gradient(120% 80% at 20% 0%, ${hsl(hue, 78, 50, 0.5)}, ${hsl(hue + 35, 70, 40, 0.22)} 45%, transparent 75%)`;
}
