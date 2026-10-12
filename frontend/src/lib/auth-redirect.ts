/** Only allow same-origin relative paths as post-auth destinations (no open redirects). */
export function safeNextPath(next: string | null | undefined, fallback = "/"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

/** Where an auth link should land: `next` if safe, else /set-password for
 * invite/recovery (no usable password yet), else the dashboard. */
export function destinationFor(type: string | null | undefined, next: string | null | undefined): string {
  const fallback = type === "invite" || type === "recovery" ? "/set-password" : "/";
  return safeNextPath(next, fallback);
}
