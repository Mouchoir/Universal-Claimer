import type { BrowserCookie } from "./connector.js";

/**
 * Parse the Netscape `cookies.txt` format exported by common browser extensions
 * ("Get cookies.txt", etc.), the guided import method chosen for session import.
 *
 * Format: tab-separated lines of
 *   domain  includeSubdomains  path  secure  expiry  name  value
 * Lines starting with `#` are comments (the `#HttpOnly_` prefix is honored).
 */
export function parseCookiesTxt(text: string): BrowserCookie[] {
  const cookies: BrowserCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    let httpOnly = false;
    let work = line;
    if (work.startsWith("#HttpOnly_")) {
      httpOnly = true;
      work = work.slice("#HttpOnly_".length);
    } else if (work.startsWith("#")) {
      continue; // comment
    }

    const parts = work.split("\t");
    if (parts.length < 7) continue;

    const [domain, , path, secure, expiry, name, ...valueParts] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      ...string[],
    ];
    const value = valueParts.join("\t");
    if (!name) continue;

    const expires = Number(expiry);
    cookies.push({
      name,
      value,
      domain,
      path: path || "/",
      httpOnly,
      secure: secure.toUpperCase() === "TRUE",
      ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
    });
  }
  return cookies;
}

/**
 * Parse a pasted JSON cookie array (the convenience alternative to cookies.txt). Accepts
 * the Playwright/DevTools cookie shape and normalizes to {@link BrowserCookie}.
 */
export function parseCookiesJson(json: string): BrowserCookie[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) {
    throw new Error("Expected a JSON array of cookies");
  }
  return data.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Cookie at index ${i} is not an object`);
    }
    const c = entry as Record<string, unknown>;
    if (typeof c.name !== "string" || typeof c.value !== "string") {
      throw new Error(`Cookie at index ${i} is missing name/value`);
    }
    return {
      name: c.name,
      value: c.value,
      domain: typeof c.domain === "string" ? c.domain : "",
      path: typeof c.path === "string" ? c.path : "/",
      ...(typeof c.expires === "number" ? { expires: c.expires } : {}),
      ...(typeof c.httpOnly === "boolean" ? { httpOnly: c.httpOnly } : {}),
      ...(typeof c.secure === "boolean" ? { secure: c.secure } : {}),
    };
  });
}
