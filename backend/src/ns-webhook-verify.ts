// NS (Notification Server) webhook signature verifier — Svix Ed25519 scheme.
//
// Drop-in module for any miniapp backend receiving NS webhooks. Self-contained:
// reads no env vars (pass jwksUrl in) and imports nothing app-specific. Pairs
// with ns-webhook.ts (payload parsing). See ../NS_WEBHOOK.md and
// ../NOTIFICATIONS_README.md.
//
// The scheme mirrors the Svix signer:
//   toSign = `${svix-id}.${svix-timestamp}.${rawBody}`
//   ed25519 signature, base64-STANDARD encoded, header `svix-signature: v1a,<sig>`.
//   During a key rotation Svix signs with both the old and new keys for ~24h, so
//   the header may carry multiple space-separated `v1a,<sig>` entries. We accept
//   the webhook if ANY signature verifies against ANY key in the JWKS (kty OKP,
//   crv Ed25519, alg EdDSA) — the per-key `kid` no longer selects a single key.

import { importJWK } from 'jose'
import { KeyObject, verify as cryptoVerify } from 'node:crypto'

export type SvixHeaders = {
  svixId?: string
  svixTimestamp?: string
  svixSignature?: string
}

export type VerifyOptions = {
  jwksUrl: string
}

type Jwks = { keys: Array<Record<string, unknown>> }

// Module-level cache, keyed by jwksUrl so multiple NS instances don't collide.
const jwksCache = new Map<string, Jwks>()

const fetchJwks = async (jwksUrl: string): Promise<Jwks> => {
  console.log(`[ns-webhook-verify] fetching JWKS from ${jwksUrl}`)
  const res = await fetch(jwksUrl)
  if (!res.ok) throw new Error(`ns-webhook-verify: failed to fetch JWKS: HTTP ${res.status}`)
  const jwks = (await res.json()) as Jwks
  if (!Array.isArray(jwks?.keys)) {
    throw new Error('ns-webhook-verify: JWKS response has no "keys" array')
  }
  console.log(`[ns-webhook-verify] JWKS loaded: ${jwks.keys.length} key(s), kids=${jwks.keys.map((k) => k.kid).join(',')}`)
  return jwks
}

// Load every usable Ed25519 public key from the JWKS. Svix signs with multiple
// keys during rotation, so we verify against all of them rather than selecting
// one by kid. forceRefresh bypasses the cache (used to pick up a just-rotated key).
const loadEd25519PublicKeys = async (jwksUrl: string, forceRefresh = false): Promise<KeyObject[]> => {
  let jwks = forceRefresh ? undefined : jwksCache.get(jwksUrl)
  if (jwks) {
    console.log(`[ns-webhook-verify] using cached JWKS for ${jwksUrl}`)
  } else {
    jwks = await fetchJwks(jwksUrl)
    jwksCache.set(jwksUrl, jwks)
  }

  const keys: KeyObject[] = []
  for (const jwk of jwks.keys) {
    try {
      // jose v6 returns a WebCrypto CryptoKey for OKP/Ed25519 (Uint8Array only
      // for symmetric keys). crypto.verify wants a Node KeyObject, so convert.
      const cryptoKey = await importJWK(jwk, 'EdDSA')
      if (cryptoKey instanceof Uint8Array) continue // symmetric material — not a verify key
      keys.push(KeyObject.from(cryptoKey))
    } catch (err) {
      // A single unimportable / non-Ed25519 key must not sink the whole batch.
      console.log(
        `[ns-webhook-verify] skipping JWKS key kid="${jwk.kid}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  if (keys.length === 0) throw new Error('ns-webhook-verify: JWKS has no usable Ed25519 keys')
  return keys
}

// Verifies the Svix Ed25519 signature. Throws on any failure.
// Replay protection (svix-timestamp freshness) is intentionally NOT enforced —
// the header is still required because it is part of the signed string.
export const verifyWebhookSignature = async (
  rawBody: string,
  headers: SvixHeaders,
  { jwksUrl }: VerifyOptions,
): Promise<void> => {
  const { svixId, svixTimestamp, svixSignature } = headers
  if (!svixId || !svixTimestamp || !svixSignature) {
    throw new Error('ns-webhook-verify: missing one of svix-id / svix-timestamp / svix-signature')
  }

  const toSign = Buffer.from(`${svixId}.${svixTimestamp}.${rawBody}`)

  // svix-signature = "v1a,<sig> v1a,<sig> ..." — Svix emits multiple entries
  // during the 24h key-rotation window. Accept if any v1a entry verifies.
  // Guard the sig part so a malformed comma-less entry ("v1a") doesn't reach Buffer.from(undefined).
  const candidates = svixSignature
    .split(' ')
    .map((entry) => entry.split(','))
    .filter(([scheme, sig]) => scheme === 'v1a' && typeof sig === 'string' && sig.length > 0)
    .map(([, sig]) => sig)

  if (candidates.length === 0) {
    throw new Error('ns-webhook-verify: no v1a signature in svix-signature header')
  }

  const sigBytesList = candidates.map((sig) => Buffer.from(sig, 'base64')) // base64 STANDARD, not base64url

  // "Was any signature created with any of the JWKS keys?" — try every signature
  // against every key. Ed25519: algorithm arg is null; the key implies the digest.
  const tryVerify = (keys: KeyObject[]): boolean =>
    sigBytesList.some((sigBytes) =>
      keys.some((key) => {
        // crypto.verify throws on a malformed candidate (e.g. wrong signature
        // length); treat that as a non-match so other sigs/keys are still tried.
        try {
          return cryptoVerify(null, toSign, key, sigBytes)
        } catch {
          return false
        }
      }),
    )

  // Refetch the JWKS once if nothing matches the cached keys (NS may have just
  // rotated and published a new key) — only worthwhile if we were serving cache.
  const wasCached = jwksCache.has(jwksUrl)
  if (tryVerify(await loadEd25519PublicKeys(jwksUrl))) return

  if (wasCached) {
    console.log('[ns-webhook-verify] no signature matched cached JWKS, refetching once')
    if (tryVerify(await loadEd25519PublicKeys(jwksUrl, true))) return
  }

  throw new Error('ns-webhook-verify: Svix signature verification failed')
}
