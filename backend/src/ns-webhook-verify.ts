// NS (Notification Server) webhook signature verifier — Svix Ed25519 scheme.
//
// Drop-in module for any miniapp backend receiving NS webhooks. Self-contained:
// reads no env vars (pass jwksUrl in) and imports nothing app-specific. Pairs
// with ns-webhook.ts (payload parsing). See ../NS_WEBHOOK.md and
// ../NOTIFICATIONS_README.md.
//
// The scheme mirrors the NS signer exactly:
//   toSign = `${svix-id}.${svix-timestamp}.${rawBody}`
//   ed25519 signature, base64-STANDARD encoded, header `svix-signature: v1,<sig>`
//   x-key-id selects the JWKS key (kty OKP, crv Ed25519, alg EdDSA).

import { importJWK } from 'jose'
import { KeyObject, verify as cryptoVerify } from 'node:crypto'

export type SvixHeaders = {
  svixId?: string
  svixTimestamp?: string
  svixSignature?: string
  keyId?: string
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

const loadEd25519PublicKey = async (jwksUrl: string, kid: string): Promise<KeyObject> => {
  let jwks = jwksCache.get(jwksUrl)
  if (jwks) {
    console.log(`[ns-webhook-verify] using cached JWKS for ${jwksUrl}`)
  } else {
    jwks = await fetchJwks(jwksUrl)
    jwksCache.set(jwksUrl, jwks)
  }
  let jwk = jwks.keys.find((k) => k.kid === kid)
  if (!jwk) {
    // kid miss → refetch once (NS may have rotated keys).
    console.log(`[ns-webhook-verify] kid "${kid}" not in cached JWKS, refetching once`)
    jwks = await fetchJwks(jwksUrl)
    jwksCache.set(jwksUrl, jwks)
    jwk = jwks.keys.find((k) => k.kid === kid)
  }
  if (!jwk) throw new Error(`ns-webhook-verify: no JWKS key for kid "${kid}"`)
  console.log(`[ns-webhook-verify] matched key for kid "${kid}"`)

  // jose v6 returns a WebCrypto CryptoKey for OKP/Ed25519 (Uint8Array only for
  // symmetric keys). crypto.verify wants a Node KeyObject, so convert.
  const cryptoKey = await importJWK(jwk, 'EdDSA')
  if (cryptoKey instanceof Uint8Array) {
    throw new Error('ns-webhook-verify: expected an asymmetric Ed25519 key, got symmetric key material')
  }
  return KeyObject.from(cryptoKey)
}

// Verifies the Svix Ed25519 signature. Throws on any failure.
// Replay protection (svix-timestamp freshness) is intentionally NOT enforced —
// the header is still required because it is part of the signed string.
export const verifyWebhookSignature = async (
  rawBody: string,
  headers: SvixHeaders,
  { jwksUrl }: VerifyOptions,
): Promise<void> => {
  const { svixId, svixTimestamp, svixSignature, keyId } = headers
  if (!svixId || !svixTimestamp || !svixSignature || !keyId) {
    throw new Error('ns-webhook-verify: missing one of svix-id / svix-timestamp / svix-signature / x-key-id')
  }

  const key = await loadEd25519PublicKey(jwksUrl, keyId)
  const toSign = Buffer.from(`${svixId}.${svixTimestamp}.${rawBody}`)

  // svix-signature = "v1,<sig> v2,<sig> ..." — accept if any v1 entry verifies.
  // Guard the sig part so a malformed comma-less entry ("v1") doesn't reach Buffer.from(undefined).
  const candidates = svixSignature
    .split(' ')
    .map((entry) => entry.split(','))
    .filter(([scheme, sig]) => scheme === 'v1' && typeof sig === 'string' && sig.length > 0)
    .map(([, sig]) => sig)

  if (candidates.length === 0) {
    throw new Error('ns-webhook-verify: no v1 signature in svix-signature header')
  }

  for (const sig of candidates) {
    const sigBytes = Buffer.from(sig, 'base64') // base64 STANDARD, not base64url
    // Ed25519: algorithm arg is null; the key implies the digest.
    if (cryptoVerify(null, toSign, key, sigBytes)) return
  }

  throw new Error('ns-webhook-verify: Svix signature verification failed')
}
