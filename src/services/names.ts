/** The music services qobuz-helper knows. */

export const SERVICES = ["qobuz", "tidal", "spotify"] as const;
export type ServiceName = (typeof SERVICES)[number];

/** Their names as shown to the user. */
export const SERVICE_LABELS: Record<ServiceName, string> = {
  qobuz: "Qobuz",
  tidal: "TIDAL",
  spotify: "Spotify",
};

export function isServiceName(value: unknown): value is ServiceName {
  return (SERVICES as readonly unknown[]).includes(value);
}
