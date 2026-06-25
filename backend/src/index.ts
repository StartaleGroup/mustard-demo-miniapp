import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { NS_WEBHOOK_EVENTS, parseWebhookPayload } from './ns-webhook.js'
import { verifyWebhookSignature } from './ns-webhook-verify.js'

const app = new Hono()
app.use('*', cors())

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5174'
const PORT = Number(process.env.PORT || 3300)
const NS_JWKS_URL = process.env.NS_JWKS_URL
const LOG_PREFIX = '[MUSTARD]'

const tokensByAddress = new Map<string, { token: string; url: string }>()

// `url` is captured at schedule time so a later miniapp_removed clearing the
// token doesn't strand the queued item without a send target.
const scheduledNotifications: Array<{
  id: string
  scheduledFor: number
  url: string
  notification: {
    notificationId: string
    title: string
    body: string
    targetUrl: string
    tokens: string[]
  }
}> = []

const testNotificationBodies = [
  'Chris just minted a banana',
  'Marc wanted to mute me',
  'J did not review this',
  'Alan wants to move to Bali',
  'Ayumi does not like my design',
  'Saša did not like new Remarkable',
  'Brett is going to the gym',
]

let nextTestNotificationBodyIndex = 0

// NS tokens share a common prefix (ntf_<ULID>.sk_live_...), so the trailing
// chars are what actually distinguish one token from another.
const tokenPreview = (token: string) => `...${token.slice(-8)}`

// NS response body echoes back full tokens in successful/invalid/rateLimited
// arrays. Preview them so we never log full tokens.
const previewNsResponseBody = (body: string) => {
  try {
    const parsed = JSON.parse(body)
    const previewArray = (value: unknown) =>
      Array.isArray(value) ? value.map((t) => (typeof t === 'string' ? tokenPreview(t) : t)) : value
    return {
      ...parsed,
      successfulTokens: previewArray(parsed.successfulTokens),
      invalidTokens: previewArray(parsed.invalidTokens),
      rateLimitedTokens: previewArray(parsed.rateLimitedTokens),
    }
  } catch {
    return body
  }
}

const normalizeUserAddress = (userAddress: string) => userAddress.toLowerCase()

const logTokenStore = (label: string) => {
  const entries = Array.from(tokensByAddress.entries()).map(([address, entry]) => ({
    address,
    tokenPreview: tokenPreview(entry.token),
    url: entry.url,
  }))
  console.log(`${LOG_PREFIX} [store] ${label}: count=${entries.length}`, entries)
}

async function sendNotification(
  url: string,
  payload: { notificationId: string; title: string; body: string; targetUrl: string; tokens: string[] },
) {
  console.log(`${LOG_PREFIX} [send] outgoing payload`, {
    url,
    notificationId: payload.notificationId,
    title: payload.title,
    body: payload.body,
    targetUrl: payload.targetUrl,
    tokensCount: payload.tokens.length,
    tokensPreview: payload.tokens.map(tokenPreview),
  })

  const startedAt = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const elapsedMs = Date.now() - startedAt
  const responseBody = await response.text()

  console.log(`${LOG_PREFIX} [send] NS response`, {
    status: response.status,
    elapsedMs,
    notificationId: payload.notificationId,
    body: previewNsResponseBody(responseBody),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${responseBody}`)
  }
  return responseBody
}

// See backend/NOTIFICATIONS_README.md for the NS webhook contract.
app.post('/webhook', async (c) => {
  const rawBody = await c.req.text()
  console.log(`${LOG_PREFIX} [webhook] ===== incoming request =====`)
  console.log(`${LOG_PREFIX} [webhook] method=${c.req.method} url=${c.req.url}`)

  // Verify the Svix Ed25519 signature before trusting the body. Runs first, so
  // forged/tampered webhooks never reach the parser. Replay protection
  // (svix-timestamp freshness) is intentionally not enforced — see ns-webhook-verify.ts.
  if (!NS_JWKS_URL) {
    console.error(`${LOG_PREFIX} [webhook] NS_JWKS_URL not configured`)
    return c.json({ success: false, error: 'server misconfigured' }, 500)
  }
  const svixId = c.req.header('svix-id')
  const svixTimestamp = c.req.header('svix-timestamp')
  const svixSignature = c.req.header('svix-signature')
  // Preview the signature so we trace which entry arrived without logging the full sig.
  const svixSignaturePreview = svixSignature ? `${svixSignature.slice(0, 12)}...` : 'MISSING'
  console.log(
    `${LOG_PREFIX} [webhook] verifying signature: svix-id=${svixId ?? 'MISSING'} svix-timestamp=${svixTimestamp ?? 'MISSING'} svix-signature=${svixSignaturePreview} jwksUrl=${NS_JWKS_URL}`,
  )
  const verifyStartedAt = Date.now()
  try {
    await verifyWebhookSignature(rawBody, { svixId, svixTimestamp, svixSignature }, { jwksUrl: NS_JWKS_URL })
  } catch (err) {
    console.error(`${LOG_PREFIX} [webhook] signature verification FAILED (${Date.now() - verifyStartedAt}ms):`, err)
    return c.json({ success: false, error: 'invalid signature' }, 401)
  }
  console.log(`${LOG_PREFIX} [webhook] signature verification OK (${Date.now() - verifyStartedAt}ms)`)

  let payload: ReturnType<typeof parseWebhookPayload>
  try {
    payload = parseWebhookPayload(rawBody)
  } catch (err) {
    console.error(`${LOG_PREFIX} [webhook] failed to parse NS payload:`, err)
    return c.json({ success: false, error: 'invalid payload' }, 400)
  }

  const userAddress = payload.userAddress ? normalizeUserAddress(payload.userAddress) : undefined
  console.log(
    `${LOG_PREFIX} [webhook] parsed payload: event=${payload.event} senderId=${payload.senderId} userAddress=${userAddress ?? 'MISSING'}`,
  )

  switch (payload.event) {
    case NS_WEBHOOK_EVENTS.MINIAPP_ADDED:
    case NS_WEBHOOK_EVENTS.NOTIFICATIONS_ENABLED: {
      if (!userAddress) {
        console.error(`${LOG_PREFIX} [webhook] ${payload.event} missing userAddress in payload, cannot store token`)
        return c.json({ success: false, error: 'missing userAddress' }, 400)
      }
      const { token, url } = payload.notificationDetails
      tokensByAddress.set(userAddress, { token, url })
      console.log(
        `${LOG_PREFIX} [webhook] ${payload.event} senderId=${payload.senderId} userAddress=${userAddress} token=${tokenPreview(token)} url=${url}`,
      )
      logTokenStore(`after ${payload.event}`)
      break
    }
    case NS_WEBHOOK_EVENTS.MINIAPP_REMOVED:
    case NS_WEBHOOK_EVENTS.NOTIFICATIONS_DISABLED:
      if (userAddress) {
        tokensByAddress.delete(userAddress)
      }
      console.log(`${LOG_PREFIX} [webhook] ${payload.event} senderId=${payload.senderId} userAddress=${userAddress ?? 'MISSING'}`)
      logTokenStore(`after ${payload.event}`)
      break
  }

  console.log(`${LOG_PREFIX} [webhook] ===== handled ${payload.event} OK (200) =====`)
  return c.json({ success: true })
})

app.post('/api/mint', async (c) => {
  const body = await c.req.json() as { userAddress?: string }
  const normalizedUserAddress = body.userAddress ? normalizeUserAddress(body.userAddress) : undefined
  console.log(`${LOG_PREFIX} [mint] received request, userAddress=${body.userAddress || 'MISSING'}`)

  if (!normalizedUserAddress) {
    return c.json({ error: 'Missing userAddress' }, 400)
  }

  const entry = tokensByAddress.get(normalizedUserAddress)
  if (!entry) {
    console.log(`${LOG_PREFIX} [mint] no notification token found for address ${normalizedUserAddress}`)
    return c.json({ error: 'No notification registered for this address' }, 404)
  }

  const now = Date.now()

  try {
    const immediatePayload = {
      notificationId: `mustard-minted-${now}`,
      title: 'Test mint notification',
      body: 'New Mustard NFT was minted!',
      targetUrl: FRONTEND_URL,
      tokens: [entry.token],
    }
    console.log(`${LOG_PREFIX} [mint] sending immediate notification to ${entry.url}`)
    const result = await sendNotification(entry.url, immediatePayload)
    console.log(`${LOG_PREFIX} [mint] immediate notification sent:`, result)
  } catch (e) {
    console.error(`${LOG_PREFIX} [mint] failed to send immediate notification:`, e)
  }

  const MINT_AGAIN_DELAY_MS = 20_000
  const notificationId = `mustardready-${now}`
  const scheduledFor = now + MINT_AGAIN_DELAY_MS

  scheduledNotifications.push({
    id: notificationId,
    scheduledFor,
    url: entry.url,
    notification: {
      notificationId,
      title: 'Test scheduled notification',
      body: 'You can mint NFT again!',
      targetUrl: FRONTEND_URL,
      tokens: [entry.token],
    },
  })

  const scheduledDate = new Date(scheduledFor).toLocaleTimeString()
  console.log(`${LOG_PREFIX} [scheduler] notification "${notificationId}" scheduled for ${scheduledDate} (in ${MINT_AGAIN_DELAY_MS / 1000}s)`)
  console.log(`${LOG_PREFIX} [scheduler] queue size: ${scheduledNotifications.length}`)

  return c.json({ success: true, scheduledFor })
})

app.post('/api/test-notification', async (c) => {
  const body = await c.req.json() as { userAddress?: string }
  const normalizedUserAddress = body.userAddress ? normalizeUserAddress(body.userAddress) : undefined
  console.log(`${LOG_PREFIX} [test] received request, userAddress=${body.userAddress || "MISSING"}`)

  if (!normalizedUserAddress) {
    return c.json({ error: 'Missing userAddress' }, 400)
  }

  const entry = tokensByAddress.get(normalizedUserAddress)
  if (!entry) {
    console.log(`${LOG_PREFIX} [test] no notification token found for address ${normalizedUserAddress}`)
    return c.json({ error: 'No notification registered for this address' }, 404)
  }

  try {
    const notificationBody = testNotificationBodies[nextTestNotificationBodyIndex]
    nextTestNotificationBodyIndex = (nextTestNotificationBodyIndex + 1) % testNotificationBodies.length

    const payload = {
      notificationId: `mustard-test-${Date.now()}`,
      title: 'Test notification',
      body: notificationBody,
      targetUrl: FRONTEND_URL,
      tokens: [entry.token],
    }
    console.log(`${LOG_PREFIX} [test] sending test notification to ${entry.url}`)
    const result = await sendNotification(entry.url, payload)
    console.log(`${LOG_PREFIX} [test] notification sent:`, result)
    return c.json({ success: true })
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : 'Failed to send notification'
    console.error(`${LOG_PREFIX} [test] failed to send notification:`, e)
    return c.json({ error: errorMessage }, 500)
  }
})

// Suppress identical poll lines — the frontend polls this endpoint on a short interval.
const lastStatusLog = new Map<string, boolean>()

app.get('/api/notification-status', (c) => {
  const userAddress = c.req.query('userAddress')
  const normalizedUserAddress = userAddress ? normalizeUserAddress(userAddress) : undefined
  if (!normalizedUserAddress) {
    return c.json({ error: 'Missing userAddress query param' }, 400)
  }
  const entry = tokensByAddress.get(normalizedUserAddress)
  const enabled = entry !== undefined

  if (lastStatusLog.get(normalizedUserAddress) !== enabled) {
    console.log(`${LOG_PREFIX} [status] userAddress=${normalizedUserAddress}, enabled=${enabled}`)
    if (entry) {
      console.log(`${LOG_PREFIX} [status] token preview for ${normalizedUserAddress}: ${tokenPreview(entry.token)}`)
    } else {
      logTokenStore('status lookup miss')
    }
    lastStatusLog.set(normalizedUserAddress, enabled)
  }

  return c.json({ enabled })
})

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    addresses: tokensByAddress.size,
    pending: scheduledNotifications.length,
  })
})

setInterval(async () => {
  const now = Date.now()
  const due = scheduledNotifications.filter(n => n.scheduledFor <= now)

  if (due.length > 0) {
    console.log(`${LOG_PREFIX} [scheduler] ${due.length} notification(s) due, processing...`)
  }

  for (const item of due) {
    console.log(`${LOG_PREFIX} [scheduler] sending to ${item.url}`)
    console.log(`${LOG_PREFIX} [scheduler] payload: ${JSON.stringify(item.notification)}`)

    try {
      const result = await sendNotification(item.url, item.notification)
      console.log(`${LOG_PREFIX} [scheduler] SUCCESS sent notification: ${item.id}`)
      console.log(`${LOG_PREFIX} [scheduler] response: ${result}`)
    } catch (e) {
      console.error(`${LOG_PREFIX} [scheduler] FAILED to send notification:`, e)
    }

    const index = scheduledNotifications.findIndex(n => n.id === item.id)
    if (index !== -1) {
      scheduledNotifications.splice(index, 1)
    }
    console.log(`${LOG_PREFIX} [scheduler] remaining queue size: ${scheduledNotifications.length}`)
  }
}, 1000)

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(LOG_PREFIX)
  console.log(`${LOG_PREFIX} \x1b[33mmustardbackend\x1b[0m — Notification Scheduler`)
  console.log(LOG_PREFIX)
  console.log(`${LOG_PREFIX} Server:          http://localhost:${info.port}`)
  console.log(`${LOG_PREFIX} Webhook:         POST http://localhost:${info.port}/webhook`)
  console.log(`${LOG_PREFIX} Mint:            POST http://localhost:${info.port}/api/mint`)
  console.log(`${LOG_PREFIX} Test Notif:      POST http://localhost:${info.port}/api/test-notification`)
  console.log(`${LOG_PREFIX} Notif Status:    GET  http://localhost:${info.port}/api/notification-status?userAddress=0x...`)
  console.log(`${LOG_PREFIX} Health:          GET  http://localhost:${info.port}/health`)
  console.log(LOG_PREFIX)
})
