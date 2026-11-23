/**
 * Whether to ask, once, about album covers: they are off until the user says
 * (ADR-0004), and a checkbox in Settings is easy to miss. Asked only with a
 * service connected (else there is nothing to show), and never again after
 * either answer -- or once covers were chosen in Settings.
 *
 * @param stored the covers setting as stored ("on" / "off"), or null
 * @param asked the stored mark that the question was answered, or null
 */
export function shouldAskArtwork(stored: string | null, asked: string | null, connected: number): boolean {
  return stored !== "on" && stored !== "off" && asked === null && connected > 0;
}
