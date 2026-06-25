# Adding NS Notifications to a Miniapp

This is a guide for wiring a miniapp backend to the Startale App **Notification
Server (NS)** so it can receive miniapp lifecycle events (a user added / removed
the miniapp, enabled / disabled notifications) and send notifications back.

It ships with two **drop-in** helper files you copy into your backend:
`src/ns-webhook.ts` (parses and runtime-narrows the webhook payload) and
`src/ns-webhook-verify.ts` (verifies the Svix Ed25519 signature). The rule is:
**call `verifyWebhookSignature()` before `parseWebhookPayload()`** — reject
forged requests before you trust the body. The
[**Mustard demo miniapp**](https://github.com/StartaleGroup/mustard-demo-miniapp)
is the reference example.

> **Status — signing scheme live.** NS signs every webhook with the **Svix**
> scheme (Ed25519 over `svix-id` / `svix-timestamp` / `svix-signature` headers)
> and carries the user address in the JSON body. Verification is **implemented**
> in `src/ns-webhook-verify.ts` and **enforced** in `src/index.ts` — webhooks
> failing verification get a `401`. Set `NS_JWKS_URL` to enable it.

---

## What you get

- **Receive** NS subscription lifecycle webhooks: a user added/removed the
  miniapp, or enabled/disabled notifications.
- **Verify** each webhook's Svix Ed25519 signature against the NS JWKS, so forged
  or tampered requests are rejected. During a key rotation the header may carry
  multiple signatures; the webhook is accepted if any one verifies against any
  JWKS key.
- **Send** notifications to NS using the per-user token NS hands you through the
  webhook.

---

## The webhook contract

NS sends a POST to a webhook URL you register with the miniapp manifest. Each
request looks like:

```http
POST /your-webhook-path HTTP/1.1
Content-Type: application/json
svix-id: msg_1717245600000000000
svix-timestamp: 1717245600
svix-signature: v1a,<base64-std Ed25519 signature — see Signature format>

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

Every event carries:

- **`senderId`** — always present; identifies the subscription's sender (miniapp).
- **`userAddress`** — the user's smart-account address, **in the body**. May be
  omitted if NS could not resolve it.

Four event types — two carry `notificationDetails`, two don't:

| `event`                  | Body shape                                                                  | When it fires                  |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------ |
| `miniapp_added`          | `{ event, senderId, userAddress?, notificationDetails: { url, token } }`    | User added the miniapp. **Store the token.** |
| `notifications_enabled`  | `{ event, senderId, userAddress?, notificationDetails: { url, token } }`    | User re-enabled notifications. **Rotate the token.** |
| `notifications_disabled` | `{ event, senderId, userAddress? }`                                         | User toggled notifications off. **Stop sending.** |
| `miniapp_removed`        | `{ event, senderId, userAddress? }`                                         | User removed the miniapp. **Delete the token.** |

`notificationDetails.url` is the fully-qualified NS send endpoint you POST to when
delivering a push — **use it verbatim, do not derive or rewrite it.**
`notificationDetails.token` is the per-user token to include in that POST. Store
both together when you receive `miniapp_added` / `notifications_enabled`; either
can change on a token rotation.

**Respond with HTTP 200** on success (any `2xx` body; most teams use
`{ "success": true }`). Anything else makes NS retry — use `400` for
malformed-body failures and `401` for signature failures so permanent errors
don't loop forever. **Confirm the exact retry policy with the Startale team**
before depending on this.

---

## Signature format

NS signs each webhook using the **Svix** scheme. Three headers carry the signature:

- **`svix-id`** — unique message id (e.g. `msg_<unixnano>`).
- **`svix-timestamp`** — unix seconds at send time.
- **`svix-signature`** — one or more space-separated `v1a,<signature>` entries,
  where `<signature>` is a **base64-standard** (not base64url) encoded raw
  **Ed25519** signature.

**Key rotation → multiple signatures.** When Svix rotates its signing key it keeps
signing with the *old* key for ~24h alongside the new one. During that window
`svix-signature` carries **multiple** space-separated entries (`v1a,<sigA> v1a,<sigB>`);
outside it, a single entry. Because more than one key may be in play, the receiver
does **not** pin to a single key — it accepts the webhook if **any** signature
verifies against **any** Ed25519 key published in the JWKS. (NS still publishes a
`kid` per key, but it no longer selects *the* verifying key.)

The signed string is:

```
${svix-id}.${svix-timestamp}.${rawBody}
```

where `rawBody` is the exact bytes of the JSON request body. Verify by:

1. Fetching the NS JWKS (`NS_JWKS_URL`) and collecting **all** its Ed25519 keys.
2. Reconstructing `toSign` from the three values above (read the body as a **raw
   string** — re-serializing parsed JSON will not byte-match).
3. Accepting the webhook if **any** `v1a` signature in the header verifies over
   `toSign` against **any** of those public keys.

This is exactly what `src/ns-webhook-verify.ts`'s `verifyWebhookSignature()` does —
it imports the JWKS key with `jose`'s `importJWK` and verifies with Node's built-in
`crypto`. (Note: `jose` v6 `importJWK` returns a WebCrypto `CryptoKey`, which the
helper converts via `KeyObject.from()` for `crypto.verify`.)

---

## Install — files to copy

Copy both files from the
[Mustard demo repo](https://github.com/StartaleGroup/mustard-demo-miniapp) into your
backend's source tree. Each is self-contained — no app imports, and the verifier
reads no environment variables (you pass config in).

| File | Responsibility |
| ---- | -------------- |
| [`src/ns-webhook.ts`](./src/ns-webhook.ts) | Parse the JSON body and narrow it to a typed event union. Throws on malformed input. |
| [`src/ns-webhook-verify.ts`](./src/ns-webhook-verify.ts) | Verify the Svix Ed25519 signature against the NS JWKS (any key matches). Throws on any failure. |

### Dependency

- **`jose`** — used only to import the JWKS Ed25519 key. Ed25519 verification
  itself uses Node's built-in `crypto`. No other runtime dependency. (`ns-webhook.ts`
  is pure TypeScript with no dependency at all.)
- **Do _not_ add the `svix` npm package.** It targets symmetric (HMAC) secrets and
  its own header handling; it does not fit this **Ed25519-via-JWKS** scheme.

---

## Configuration

| Var | Value | Notes |
| --- | ----- | ----- |
| `NS_JWKS_URL` | `https://<ns-host>/.well-known/jwks.json` | Ask the Startale team. Required for signature verification. |

The verifier module does **not** read `process.env` itself — you read `NS_JWKS_URL`
in your app and pass it as `{ jwksUrl }`. This keeps the module portable across
projects with different config conventions.

---

## Wire-up

Framework-agnostic shape:

```ts
import { NS_WEBHOOK_EVENTS, parseWebhookPayload } from './ns-webhook.js'
import { verifyWebhookSignature } from './ns-webhook-verify.js'

const NS_JWKS_URL = process.env.NS_JWKS_URL!

async function handleNsWebhook(rawBody: string, headers: {
  svixId?: string; svixTimestamp?: string; svixSignature?: string
}) {
  // 1. Verify FIRST — reject forged/tampered webhooks before parsing.
  await verifyWebhookSignature(rawBody, headers, { jwksUrl: NS_JWKS_URL }) // throws → respond 401

  // 2. Parse & narrow the (now trusted) body.
  const payload = parseWebhookPayload(rawBody)
  const userAddress = payload.userAddress?.toLowerCase() // address is in the body

  // 3. Store / rotate / delete the token keyed by userAddress.
  switch (payload.event) {
    case NS_WEBHOOK_EVENTS.MINIAPP_ADDED:
    case NS_WEBHOOK_EVENTS.NOTIFICATIONS_ENABLED:
      if (!userAddress) throw new Error('missing userAddress')
      await saveToken(userAddress, payload.notificationDetails) // { url, token }
      break
    case NS_WEBHOOK_EVENTS.NOTIFICATIONS_DISABLED:
    case NS_WEBHOOK_EVENTS.MINIAPP_REMOVED:
      if (userAddress) await removeToken(userAddress)
      break
  }
}
```

Hono (matches this repo). A `401` signature gate runs before parsing; malformed
bodies return `400`:

```ts
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text() // read ONCE — reuse for both verify and parse

  if (!NS_JWKS_URL) return c.json({ success: false, error: 'server misconfigured' }, 500)

  // 1. Verify svix-id / svix-timestamp / svix-signature → 401 on failure.
  try {
    await verifyWebhookSignature(
      rawBody,
      {
        svixId: c.req.header('svix-id'),
        svixTimestamp: c.req.header('svix-timestamp'),
        svixSignature: c.req.header('svix-signature'),
      },
      { jwksUrl: NS_JWKS_URL },
    )
  } catch {
    return c.json({ success: false, error: 'invalid signature' }, 401)
  }

  // 2. Parse & narrow the trusted body → 400 on malformed input.
  let payload: ReturnType<typeof parseWebhookPayload>
  try {
    payload = parseWebhookPayload(rawBody)
  } catch {
    return c.json({ success: false, error: 'invalid payload' }, 400)
  }

  const userAddress = payload.userAddress?.toLowerCase()
  // 3. ...store / rotate / delete the token (see switch above), then:
  return c.json({ success: true })
})
```

> **Read the body as a raw string.** Verification signs the exact bytes
> (`${svix-id}.${svix-timestamp}.${rawBody}`); re-`JSON.stringify`-ing a parsed
> object would change key order/whitespace and break verification.

---

## API reference

### `parseWebhookPayload(rawBody: string): NsWebhookPayload`

Lives in `ns-webhook.ts`. Parses the JSON body and narrows it to a typed
discriminated union. Throws on:

- invalid JSON
- unknown `event`
- missing or wrong-typed `senderId`
- a present-but-non-string `userAddress`
- missing or wrong-typed fields in `notificationDetails` (for `miniapp_added` /
  `notifications_enabled`)

### `verifyWebhookSignature(rawBody, headers, { jwksUrl }): Promise<void>`

Lives in `ns-webhook-verify.ts`. Verifies the Svix Ed25519 signature; **call it
before `parseWebhookPayload`**. Resolves on success, throws on any failure
(missing headers, JWKS fetch error, no usable keys, or no signature matching any
JWKS key) — map a throw to a `401`. Reads no env vars; pass `jwksUrl` in.

---

## Sending a notification

To deliver a notification, POST to the `notificationDetails.url` you stored (**use it
verbatim** — do not derive or rewrite it) with the matching `token`(s). Mustard's
`sendNotification()` in [`src/index.ts`](./src/index.ts) is the reference; the
request is a plain `Content-Type: application/json` POST:

```http
POST /api/v1/miniapp/send-notification HTTP/1.1
Content-Type: application/json

{
  "notificationId": "mustard-test-1782380154189",
  "title": "Test notification",
  "body": "Alan wants to move to Bali",
  "targetUrl": "https://your-miniapp.example.com",
  "tokens": ["<push token>", "..."]
}
```

| Field            | Meaning |
| ---------------- | ------- |
| `notificationId` | Your unique id for this send (e.g. `mustard-test-<timestamp>`). Use it to correlate the NS response and dedupe retries. |
| `title` / `body` | The notification's headline and message text. |
| `targetUrl`      | Where the miniapp opens when the user taps the notification. |
| `tokens`         | Array of per-user push tokens. Batch the tokens that share the **same** `notificationDetails.url` into one request. |

NS responds **200** with a body that partitions the tokens by outcome:

```json
{
  "successfulTokens": ["<token>"],
  "invalidTokens": [],
  "rateLimitedTokens": []
}
```

Act on the response:

- **`invalidTokens`** — the token is dead (user removed the miniapp / disabled
  notifications and you missed the webhook). **Delete it from your store.**
- **`rateLimitedTokens`** — NS throttled these; **retry later with backoff**, don't
  hammer.
- **`successfulTokens`** — delivered.

> **Never log full tokens.** Mustard previews them (last 8 chars) in both the
> outgoing-payload and NS-response logs — see `tokenPreview` / `previewNsResponseBody`
> in [`src/index.ts`](./src/index.ts).

---

## Production checklist

### ⚠️ Persistence — read before going to production

**Mustard stores tokens in an in-memory `Map` (`tokensByAddress` in `src/index.ts`)
and is NOT production-ready.** That is a deliberate demo simplification to keep the
example dependency-free. In-memory state is:

- **lost on every restart / redeploy** — users silently stop receiving pushes, and
- **not shared across instances** — it breaks the moment you run more than one replica.

**A database is mandatory for any production miniapp.** Persist
`(userAddress → { token, url })` in a durable store (Postgres, Redis, etc.),
updating it on `miniapp_added` / `notifications_enabled` and removing it on
`miniapp_removed` / `notifications_disabled`. Ideally also dedupe on the `svix-id`
header to make webhook delivery idempotent.

The signature-verification and parsing files are production-ready as-is; only the
**storage layer** in `index.ts` needs to be swapped for a real database.

### Replay protection

Mustard does **not** enforce `svix-timestamp` freshness (the verifier only checks
the signature). For production, consider rejecting webhooks whose `svix-timestamp`
is outside a tolerance window, plus `svix-id` dedupe, to harden against replay. NS
sends a stable `svix-id` per message; `(userAddress, event, token)` also works as a
dedupe key.

---

## Local testing (ngrok)

NS calls your `/webhook` endpoint over the public internet and **cannot reach
`localhost`**. To test the webhook flow, expose your backend through a tunnel such
as ngrok (or any equivalent) and register the resulting public `https://…/webhook`
URL with the manifest / Startale team. The Mustard example ships an ngrok service
ready to go — see the [repo README](../README.md#public-url-for-testing-ngrok).

**Testing without a live NS.** Stand up a local JWKS server and sign test webhooks
with a matching Ed25519 private key (mirror the `${id}.${ts}.${body}` signing
string, base64-standard encode the signature). Useful for exercising
`verifyWebhookSignature` without a live NS.

---

## Ask the Startale team for

1. **`NS_JWKS_URL`** — the full JWKS endpoint URL (typically
   `https://<ns-host>/.well-known/jwks.json`). Required for signature verification.
2. **Retry policy** on non-2xx responses (so you can size your idempotency window).
3. The **send-side** request contract for delivering notifications to `notificationDetails.url`.
