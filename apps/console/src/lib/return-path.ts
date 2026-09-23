/** OAuth login continuation is a local route, never a user-provided external redirect. */
export function safeReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value, "https://console.invalid");
    return url.origin === "https://console.invalid" ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}
