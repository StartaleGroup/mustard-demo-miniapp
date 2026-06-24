# NS Webhook Integration Guide (for miniapp backends)

This guide explains how to wire a miniapp backend to the **Notification Server (NS)** so it can receive miniapp lifecycle events (a user added / removed the miniapp, enabled / disabled notifications).

It ships with two drop-in helper files — `src/ns-webhook.ts` (parses and runtime-narrows the webhook payload) and `src/ns-webhook-verify.ts` (verifies the Svix Ed25519 signature). Copy both into your backend, call `verifyWebhookSignature()` before `parseWebhookPayload()`, and you're done. For a step-by-step reuse guide see [`NOTIFICATIONS_README.md`](./NOTIFICATIONS_README.md).

> **Status — signing scheme live.** NS signs every webhook with the **Svix** scheme (Ed25519 over `svix-id`/`svix-timestamp`/`svix-signature` headers) and carries the user address in the JSON body (the old `x-user-address` header was removed).
>
> Signature verification is **implemented** in `src/ns-webhook-verify.ts` and enforced in `src/index.ts` — webhooks failing verification get a `401`. Set `NS_JWKS_URL` to enable it.
>
> **Persistence note:** Mustard stores tokens in an in-memory `Map` for demo simplicity. A real database is required for production — see [`NOTIFICATIONS_README.md`](./NOTIFICATIONS_README.md).

---

## 1. What you get

NS sends a POST to a webhook URL you register with the miniapp manifest. Each request looks like:

```http
POST /your-webhook-path HTTP/1.1
Content-Type: application/json
svix-id: msg_1717245600000000000
svix-timestamp: 1717245600
svix-signature: v1a,<base64-std Ed25519 signature — see §2>

{
  "event": "miniapp_added",
  "senderId": "<sender / miniapp id>",
  "userAddress": "0x1234...abcd",
  "notificationDetails": {
    "url": "https://ns.example.com/api/v1/miniapp/send-notification",
    "token": "<push token>"
  }
}
```

> **The webhook URL must be publicly reachable.** NS calls it over the internet and **cannot reach `localhost`**. For local testing, expose your backend through a tunnel such as ngrok (or any equivalent) and register that public `https://…/webhook` URL — see the [repo README](../README.md#public-url-for-testing-ngrok).

Every event now carries:

- **`senderId`** — always present; identifies the subscription's sender (miniapp).
- **`userAddress`** — the user's smart-account address, **in the body** (the old `x-user-address` header has been removed). May be omitted if NS could not resolve it.

Four event types — two carry `notificationDetails`, two don't:

| `event`                  | Body shape                                                                  | When it fires                  |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------ |
| `miniapp_added`          | `{ event, senderId, userAddress?, notificationDetails: { url, token } }`    | User added the miniapp. **Store the token.** |
| `notifications_enabled`  | `{ event, senderId, userAddress?, notificationDetails: { url, token } }`    | User re-enabled notifications. **Rotate the token.** |
| `notifications_disabled` | `{ event, senderId, userAddress? }`                                         | User toggled notifications off. **Stop sending.** |
| `miniapp_removed`        | `{ event, senderId, userAddress? }`                                         | User removed the miniapp. **Delete the token.** |

`notificationDetails.url` is the fully-qualified NS send endpoint you POST to when delivering a push — use it verbatim, do not derive or rewrite it. (NS recently renamed this endpoint from `/notification` to `/miniapp/send-notification`; because you use the `url` verbatim, no code change is needed on your side.) `notificationDetails.token` is the per-user token to include in that POST. Store both together when you receive `miniapp_added` / `notifications_enabled`; either can change on a token rotation.

Respond with **HTTP 200** on success. Anything else makes NS retry (confirm the exact retry policy with the Startale team).

---

## 2. Signature format

NS signs each webhook using the **Svix** scheme. Three headers carry the signature:

- **`svix-id`** — unique message id (e.g. `msg_<unixnano>`).
- **`svix-timestamp`** — unix seconds at send time.
- **`svix-signature`** — one or more space-separated `v1a,<signature>` entries, where `<signature>` is a **base64-standard** (not base64url) encoded raw **Ed25519** signature.

**Key rotation → multiple signatures.** When Svix rotates its signing key it keeps signing with the *old* key for ~24h alongside the new one. During that window `svix-signature` carries **multiple** space-separated entries (`v1a,<sigA> v1a,<sigB>`); outside it, a single entry. Because more than one key may be in play, the receiver does **not** pin to a single key — it accepts the webhook if **any** signature verifies against **any** Ed25519 key published in the JWKS. (NS still publishes a `kid` per key, but it no longer selects *the* verifying key.)

The signed string is:

```
${svix-id}.${svix-timestamp}.${rawBody}
```

where `rawBody` is the exact bytes of the JSON request body. Verify by:

1. Fetching the NS JWKS (`NS_JWKS_URL`) and collecting **all** its Ed25519 keys.
2. Reconstructing `toSign` from the three values above (read the body as a **raw string** — re-serializing parsed JSON will not byte-match).
3. Accepting the webhook if **any** `v1a` signature in the header verifies over `toSign` against **any** of those public keys.

This is exactly what `src/ns-webhook-verify.ts`'s `verifyWebhookSignature()` does — it imports the JWKS key with `jose`'s `importJWK` and verifies with Node's built-in `crypto`. (Note: `jose` v6 `importJWK` returns a WebCrypto `CryptoKey`, which the helper converts via `KeyObject.from()` for `crypto.verify`.)

What to ask the Startale team:

1. **`NS_JWKS_URL`** — the full URL of the NS JWKS endpoint (typically `https://<ns-host>/.well-known/jwks.json`). Required for signature verification.
2. **Retry policy** on non-2xx responses (so you can size your idempotency window).

---

## 3. Install

Copy `src/ns-webhook.ts` and `src/ns-webhook-verify.ts` from this repo into your backend's source tree.

- `ns-webhook.ts` — pure TypeScript (JSON parse + narrow), no dependencies.
- `ns-webhook-verify.ts` — Ed25519 verification using Node's built-in `crypto` plus `jose` (`importJWK`) for JWK import. The module is env-free; pass `{ jwksUrl }` in.

```bash
NS_JWKS_URL=https://ns.example.com/.well-known/jwks.json   # ask the Startale team; required for signature verification
```

---

## 4. Use

Framework-agnostic example — adapt the request/response wiring to your framework:

```ts
import { NS_WEBHOOK_EVENTS, parseWebhookPayload } from './ns-webhook.js'
import { verifyWebhookSignature } from './ns-webhook-verify.js'

async function handleNsWebhook(rawBody: string, headers: SvixHeaders) {
  // Verify the Svix signature first; throws (→ reject with 401) if invalid.
  await verifyWebhookSignature(rawBody, headers, { jwksUrl: process.env.NS_JWKS_URL! })

  // Parse & narrow the (now trusted) body to a typed union.
  const payload = parseWebhookPayload(rawBody)

  // The user address is now in the body (no longer a header). May be absent.
  const userAddress = payload.userAddress?.toLowerCase()

  switch (payload.event) {
    case NS_WEBHOOK_EVENTS.MINIAPP_ADDED:
    case NS_WEBHOOK_EVENTS.NOTIFICATIONS_ENABLED:
      if (!userAddress) throw new Error('missing userAddress')
      // payload.notificationDetails is typed: { url, token }
      await saveToken(userAddress, payload.notificationDetails)
      break
    case NS_WEBHOOK_EVENTS.NOTIFICATIONS_DISABLED:
    case NS_WEBHOOK_EVENTS.MINIAPP_REMOVED:
      if (userAddress) await removeToken(userAddress)
      break
  }
}
```

Hono example (matches this example miniapp). A `401` signature gate runs before parsing; malformed bodies return `400`:

```ts
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text()

  // Verify svix-id / svix-timestamp / svix-signature → 401 on failure.
  try {
    await verifyWebhookSignature(
      rawBody,
      {
        svixId: c.req.header('svix-id'),
        svixTimestamp: c.req.header('svix-timestamp'),
        svixSignature: c.req.header('svix-signature'),
      },
      { jwksUrl: process.env.NS_JWKS_URL! },
    )
  } catch (err) {
    return c.json({ success: false, error: 'invalid signature' }, 401)
  }

  let payload: ReturnType<typeof parseWebhookPayload>
  try {
    payload = parseWebhookPayload(rawBody)
  } catch (err) {
    return c.json({ success: false, error: 'invalid payload' }, 400)
  }

  const userAddress = payload.userAddress?.toLowerCase()
  // ...handle payload...
  return c.json({ success: true })
})
```

> **Important**: read the body as a **raw string**, not parsed JSON. Verification needs the exact bytes that were signed — reserializing parsed JSON will not byte-match.

---

## 5. API reference (`ns-webhook.ts`)

### `parseWebhookPayload(rawBody: string): NsWebhookPayload`

Parses the JSON body and narrows it to a typed discriminated union. Throws on:

- invalid JSON
- unknown `event`
- missing or wrong-typed `senderId`
- a present-but-non-string `userAddress`
- missing or wrong-typed fields in `notificationDetails` (for `miniapp_added` / `notifications_enabled`)

### `verifyWebhookSignature(rawBody, headers, { jwksUrl }): Promise<void>`

Lives in `ns-webhook-verify.ts`. Verifies the Svix Ed25519 signature; **call it before `parseWebhookPayload`**. Resolves on success, throws on any failure (missing headers, JWKS fetch error, no usable keys, or no signature matching any JWKS key) — map a throw to a `401`. Reads no env vars; pass `jwksUrl` in.

> The former `x-user-address` header decoder is gone for good — the address is in the body now (`payload.userAddress`).

### Types & constants

```ts
NS_WEBHOOK_EVENTS.MINIAPP_ADDED           // 'miniapp_added'
NS_WEBHOOK_EVENTS.MINIAPP_REMOVED         // 'miniapp_removed'
NS_WEBHOOK_EVENTS.NOTIFICATIONS_ENABLED   // 'notifications_enabled'
NS_WEBHOOK_EVENTS.NOTIFICATIONS_DISABLED  // 'notifications_disabled'

type NotificationDetails = { url: string; token: string }

type NsWebhookPayload =
  | { event: 'miniapp_added';          senderId: string; userAddress?: string; notificationDetails: NotificationDetails }
  | { event: 'notifications_enabled';  senderId: string; userAddress?: string; notificationDetails: NotificationDetails }
  | { event: 'miniapp_removed';        senderId: string; userAddress?: string }
  | { event: 'notifications_disabled'; senderId: string; userAddress?: string }
```

---

## 6. Response contract

- **200**: webhook accepted. Use any `2xx` body (most teams use `{ "success": true }`).
- **non-200**: NS will retry per its retry policy. Use `400` for malformed-body failures and `401` for signature failures, so permanent errors don't loop forever once the policy is honored — but **confirm the retry semantics with the Startale team** before depending on this.

---

## 7. Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| `senderId is not a string` | Body is from the old (pre-Svix) NS, or not an NS webhook at all. Confirm the NS instance sends the new payload shape. |
| `missing userAddress` on add/enable | NS could not resolve the user's smart-account address. Check the NS → backend address lookup; the field is `omitzero` so it may be absent. |
| Tokens received but pushes never arrive | Unrelated to this webhook — check that you're calling the NS send endpoint (`notificationDetails.url`) correctly with the token you stored. |
| signature never verifies | Body was parsed/re-serialized before verification (read it raw), signature didn't match any JWKS key (stale JWKS cache or wrong NS instance), or base64url vs base64-standard decoding of the signature. |
| `NS_JWKS_URL env var is required` / `server misconfigured` 500 | `NS_JWKS_URL` is unset. Set it to the NS JWKS endpoint. |

---

## 8. What's NOT covered here

- **Sending notifications.** This guide is webhook-side only (NS → you). The send side (you → NS to deliver a push) posts to `notificationDetails.url` 
- **Idempotency / dedupe.** NS now sends a stable `svix-id` per message — dedupe on that if you care about retries. `(userAddress, event, token)` also works.
- **Rate limits.** NS may rate-limit your send side; webhook receive side typically isn't rate-limited.
- **Local testing without NS.** Stand up a local JWKS server and sign test webhooks with a matching Ed25519 private key (mirror the `${id}.${ts}.${body}` signing string, base64-standard encode the signature). Useful for exercising `verifyWebhookSignature` without a live NS; otherwise out of scope for this guide.
