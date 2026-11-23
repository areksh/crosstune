/** ISRCs compare case-insensitively, ignoring hyphens and spaces. */
export function normaliseIsrc(isrc: string): string {
  return isrc.replace(/[\s-]/g, "").toUpperCase();
}
