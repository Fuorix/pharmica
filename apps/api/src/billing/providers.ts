import { createHmac, timingSafeEqual } from "node:crypto";
import type { SubscriptionPaymentMethod } from "@pharmica/contracts";

/**
 * Online subscription payments. Each provider (JazzCash, Easypaisa, Raast) reports a payment to
 * POST /api/v1/billing/callback/<provider> in the normalised form below, signed with an HMAC-SHA256 of the raw body
 * using that provider secret. Until a provider is connected and its secret configured, its callback refuses everything.
 * When credentials arrive, a small adapter in front of this translates the provider own format into this one.
 */
export const PROVIDERS = { jazzcash: "JAZZCASH", easypaisa: "EASYPAISA", raast: "RAAST" } as const satisfies Record<string, SubscriptionPaymentMethod>;
export type ProviderKey = keyof typeof PROVIDERS;
export const SIGNATURE_HEADER = "x-pharmica-signature";

export interface ProviderCallback {
  /** The provider transaction ID; a repeated callback with the same ID is applied once. */
  transactionId: string;
  /** The Pharmica invoice number the shop paid, e.g. PH-2026-000042. */
  invoiceNumber: string;
  amount: number;
  status: "SUCCESS" | "FAILED";
  paidAt?: string;
}

const secretFor = (provider: ProviderKey) => process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`] || "";

/** Online methods the server can accept, so the owner panel only offers what works. */
export function configuredProviders(): SubscriptionPaymentMethod[] {
  return (Object.keys(PROVIDERS) as ProviderKey[]).filter((provider) => secretFor(provider) && process.env[`PAYMENT_CHECKOUT_URL_${provider.toUpperCase()}`]).map((provider) => PROVIDERS[provider]);
}

export function isProvider(value: string): value is ProviderKey {
  return Object.hasOwn(PROVIDERS, value);
}

export function signatureFor(provider: ProviderKey, rawBody: string): string | null {
  const secret = secretFor(provider);
  return secret ? `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}` : null;
}

/** Constant-time check of the signature header against the body. False when the provider is not configured. */
export function verifySignature(provider: ProviderKey, rawBody: string, header: string | null): boolean {
  const expected = signatureFor(provider, rawBody);
  if (!expected || !header) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(header.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}
