import type { Request } from "express";

/** Every value of cookie `name` in the request's Cookie header, trimmed. Callers decide how to treat duplicates. */
export function readCookies(req: Request, name: string): string[] {
  const header = req.headers?.cookie;
  if (typeof header !== "string") return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}
