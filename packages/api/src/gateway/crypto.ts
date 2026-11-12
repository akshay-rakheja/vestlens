import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  if (!CHALLENGE_PATTERN.test(challenge)) return false;
  // Compare against the re-encoded digest so non-canonical encodings never match.
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  return timingSafeEqual(Buffer.from(challenge), expected);
}
