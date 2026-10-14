/**
 * Offline PIN check. After a cashier signs in online, the counter keeps a salted PBKDF2 hash of their PIN so
 * they can sign in again while the internet is down. Only people who have signed in online on this counter
 * can sign in offline, and repeated wrong PINs lock the user out locally.
 */
export interface PinVerifier {
  userId: string;
  salt: string;
  hash: string;
  iterations: number;
  failures: number;
  lockedUntil: string | null;
}

const ITERATIONS = 210_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const toHex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return toHex(bits);
}

export async function createPinVerifier(userId: string, pin: string): Promise<PinVerifier> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { userId, salt: toHex(salt), hash: await derive(pin, salt, ITERATIONS), iterations: ITERATIONS, failures: 0, lockedUntil: null };
}

export type PinCheck = { ok: true; verifier: PinVerifier } | { ok: false; verifier: PinVerifier; locked: boolean };

/** Checks a PIN and returns the updated verifier (failure count and lockout) for the caller to save. */
export async function checkPin(verifier: PinVerifier, pin: string, now = new Date()): Promise<PinCheck> {
  if (verifier.lockedUntil && new Date(verifier.lockedUntil) > now) return { ok: false, verifier, locked: true };
  const hash = await derive(pin, fromHex(verifier.salt), verifier.iterations);
  // Compare without exiting early so timing does not reveal how much of the hash matched.
  let difference = hash.length ^ verifier.hash.length;
  for (let index = 0; index < Math.min(hash.length, verifier.hash.length); index++) difference |= hash.charCodeAt(index) ^ verifier.hash.charCodeAt(index);
  if (difference === 0) return { ok: true, verifier: { ...verifier, failures: 0, lockedUntil: null } };

  const failures = verifier.failures + 1;
  const locked = failures >= MAX_FAILURES;
  return { ok: false, locked, verifier: { ...verifier, failures: locked ? 0 : failures, lockedUntil: locked ? new Date(now.getTime() + LOCKOUT_MS).toISOString() : null } };
}
