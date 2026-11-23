/** The page the browser ends on after a sign-in: text only, nothing loaded. */

export interface SignInResult {
  ok: boolean;
  message: string;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export function signInPage({ ok, message }: SignInResult): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>qobuz-helper</title></head>' +
    '<body style="font-family:system-ui;background:#1a1d1f;color:#ece8df;text-align:center;padding:64px">' +
    `<h1 style="font-size:24px">${ok ? "Connected" : "Not connected"}</h1><p>${escape(message)}</p>` +
    `<p>${ok ? "You can close this tab and go back to qobuz-helper." : "Go back to qobuz-helper to try again."}</p></body></html>`
  );
}

/** The sign-in's answer must not be kept, framed, or passed on as a referrer. */
export const SIGN_IN_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
} as const;
