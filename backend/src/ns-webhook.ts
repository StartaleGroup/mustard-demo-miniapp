// NS (Notification Server) webhook helper — payload parsing & narrowing.
//
// Drop-in module for any miniapp backend that needs to receive NS subscription
// webhooks. See ../NS_WEBHOOK.md and ../NOTIFICATIONS_README.md.
//
// This file is parse-only. Signature verification lives in the companion
// drop-in `ns-webhook-verify.ts` (Svix Ed25519 over svix-id / svix-timestamp /
// svix-signature headers + JWKS keyed by x-key-id). Copy both files together
// and call verifyWebhookSignature() before parseWebhookPayload().
//
// The user address travels in the JSON body (`userAddress`) — the old
// `x-user-address` header was removed.

export const NS_WEBHOOK_EVENTS = {
  MINIAPP_ADDED: 'miniapp_added',
  MINIAPP_REMOVED: 'miniapp_removed',
  NOTIFICATIONS_ENABLED: 'notifications_enabled',
  NOTIFICATIONS_DISABLED: 'notifications_disabled',
} as const

export type NotificationDetails = {
  url: string
  token: string
}

// Every event now carries `senderId` (always present) and an optional
// `userAddress` (omitted when NS could not resolve the address; absent on some
// events). `notificationDetails` is only present on add/enable events.
type WebhookCommon = {
  senderId: string
  userAddress?: string
}

export type NsWebhookPayload =
  | (WebhookCommon & { event: typeof NS_WEBHOOK_EVENTS.MINIAPP_ADDED; notificationDetails: NotificationDetails })
  | (WebhookCommon & { event: typeof NS_WEBHOOK_EVENTS.NOTIFICATIONS_ENABLED; notificationDetails: NotificationDetails })
  | (WebhookCommon & { event: typeof NS_WEBHOOK_EVENTS.MINIAPP_REMOVED })
  | (WebhookCommon & { event: typeof NS_WEBHOOK_EVENTS.NOTIFICATIONS_DISABLED })

export function parseWebhookPayload(rawBody: string): NsWebhookPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch (err) {
    throw new Error(`ns-webhook: body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ns-webhook: body is not a JSON object')
  }

  const envelope = parsed as {
    event?: unknown
    senderId?: unknown
    userAddress?: unknown
    notificationDetails?: unknown
  }
  const event = envelope.event

  if (typeof envelope.senderId !== 'string') {
    throw new Error('ns-webhook: senderId is not a string')
  }
  if (envelope.userAddress !== undefined && typeof envelope.userAddress !== 'string') {
    throw new Error('ns-webhook: userAddress is present but not a string')
  }
  const common: WebhookCommon = { senderId: envelope.senderId, userAddress: envelope.userAddress }

  if (event === NS_WEBHOOK_EVENTS.MINIAPP_ADDED || event === NS_WEBHOOK_EVENTS.NOTIFICATIONS_ENABLED) {
    const details = assertNotificationDetails(envelope.notificationDetails)
    return { ...common, event, notificationDetails: details }
  }
  if (event === NS_WEBHOOK_EVENTS.MINIAPP_REMOVED || event === NS_WEBHOOK_EVENTS.NOTIFICATIONS_DISABLED) {
    return { ...common, event }
  }

  throw new Error(`ns-webhook: unknown event "${String(event)}"`)
}

function assertNotificationDetails(value: unknown): NotificationDetails {
  if (!value || typeof value !== 'object') {
    throw new Error('ns-webhook: notificationDetails is not an object')
  }
  const d = value as Record<string, unknown>
  if (typeof d.url !== 'string') throw new Error('ns-webhook: notificationDetails.url is not a string')
  if (typeof d.token !== 'string') throw new Error('ns-webhook: notificationDetails.token is not a string')
  return { url: d.url, token: d.token }
}
