# Adding NS Notifications to a Miniapp (reuse guide)

This guide shows how to add **Notification Server (NS)** notifications to any miniapp
backend by reusing two drop-in files from this repo. **Mustard is the reference example** —
copy the files, wire them up, and you have a working webhook receiver with signature
verification.

For the exact webhook contract (events, payload shapes, headers), see [`NS_WEBHOOK.md`](./NS_WEBHOOK.md).

---

## What you get

- **Receive** NS subscription lifecycle webhooks: a user added/removed the miniapp, or
  enabled/disabled notifications.
- **Verify** each webhook's Svix Ed25519 signature against the NS JWKS, so forged or
  tampered requests are rejected.
- **Send** pushes back to NS using the per-user token NS hands you.

---

## Files to copy

Copy both into your backend's source tree. Each is self-contained — no app imports, and the
verifier reads no environment variables (you pass config in).

| File | Responsibility |
| ---- | -------------- |
| [`src/ns-webhook.ts`](./src/ns-webhook.ts) | Parse the JSON body and narrow it to a typed event union. Throws on malformed input. |
| [`src/ns-webhook-verify.ts`](./src/ns-webhook-verify.ts) | Verify the Svix Ed25519 signature against the NS JWKS (keyed by `x-key-id`). Throws on any failure. |

### Dependency

- **`jose`** — used only to import the JWKS Ed25519 key. Ed25519 verification itself uses
  Node's built-in `crypto`. No other runtime dependency.
- **Do _not_ add the `svix` npm package.** It targets symmetric (HMAC) secrets and its own
  header handling; it does not fit this **Ed25519-via-JWKS** scheme.

---

## Configuration

| Var | Value | Notes |
| --- | ----- | ----- |
| `NS_JWKS_URL` | `https://<ns-host>/.well-known/jwks.json` | Ask the NS team. Required for signature verification. |

The verifier module does **not** read `process.env` itself — you read `NS_JWKS_URL` in your
app and pass it as `{ jwksUrl }`. This keeps the module portable across projects with
different config conventions.

---

## Wire-up

Framework-agnostic shape:

```ts
import { NS_WEBHOOK_EVENTS, parseWebhookPayload } from './ns-webhook.js'
import { verifyWebhookSignature } from './ns-webhook-verify.js'

const NS_JWKS_URL = process.env.NS_JWKS_URL!

async function handleNsWebhook(rawBody: string, headers: {
  svixId?: string; svixTimestamp?: string; svixSignature?: string; keyId?: string
}) {
  // 1. Verify FIRST — reject forged/tampered webhooks before parsing.
  await verifyWebhookSignature(rawBody, headers, { jwksUrl: NS_JWKS_URL }) // throws → respond 401

  // 2. Parse & narrow the (now trusted) body.
  const payload = parseWebhookPayload(rawBody)
  const userAddress = payload.userAddress?.toLowerCase() // address is in the body now

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

Hono (matches this repo):

```ts
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text() // read ONCE — reuse for both verify and parse

  if (!NS_JWKS_URL) return c.json({ success: false, error: 'server misconfigured' }, 500)
  try {
    await verifyWebhookSignature(
      rawBody,
      {
        svixId: c.req.header('svix-id'),
        svixTimestamp: c.req.header('svix-timestamp'),
        svixSignature: c.req.header('svix-signature'),
        keyId: c.req.header('x-key-id'),
      },
      { jwksUrl: NS_JWKS_URL },
    )
  } catch {
    return c.json({ success: false, error: 'invalid signature' }, 401)
  }

  const payload = parseWebhookPayload(rawBody)
  // ...handle events, return 200...
})
```

> **Read the body as a raw string.** Verification signs the exact bytes
> (`${svix-id}.${svix-timestamp}.${rawBody}`); re-`JSON.stringify`-ing a parsed object would
> change key order/whitespace and break verification.

### Sending a push

When you want to deliver a notification, POST to the `notificationDetails.url` you stored
(**use it verbatim** — do not derive or rewrite it) with the stored `token`. See
[`NS_WEBHOOK.md`](./NS_WEBHOOK.md) §8 and the NS team for the send-side request contract.

---

## ⚠️ Persistence — read before going to production

**Mustard stores tokens in an in-memory `Map` (`tokensByAddress` in `src/index.ts`) and is
NOT production-ready.** That is a deliberate demo simplification to keep the example
dependency-free. In-memory state is:

- **lost on every restart / redeploy** — users silently stop receiving pushes, and
- **not shared across instances** — it breaks the moment you run more than one replica.

**A database is mandatory for any production miniapp.** Persist `(userAddress → { token, url })`
in a durable store (Postgres, Redis, etc.), updating it on `miniapp_added` /
`notifications_enabled` and removing it on `miniapp_removed` / `notifications_disabled`.
Ideally also dedupe on the `svix-id` header to make webhook delivery idempotent.

The signature-verification and parsing files are production-ready as-is; only the **storage
layer** in `index.ts` needs to be swapped for a real database.

---

## Replay protection

Mustard does **not** enforce `svix-timestamp` freshness (the verifier only checks the
signature). For production, consider rejecting webhooks whose `svix-timestamp` is outside a
tolerance window, plus `svix-id` dedupe, to harden against replay.

---

## Ask the NS team for

1. **`NS_JWKS_URL`** — the full JWKS endpoint URL.
2. **Retry policy** on non-2xx responses (so you can size your idempotency window).
3. The **send-side** request contract for delivering pushes to `notificationDetails.url`.
