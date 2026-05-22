import { sdk } from "@farcaster/miniapp-sdk";
import { useCallback, useEffect, useState } from "react";

type EventEntry = { event: string; detail: string; timestamp: string };

interface NotificationSectionProps {
  appName: string;
  accentColor: string;
  backendUrl: string;
  userAddress: string;
}

// localStorage key for the manual-test token. The new Notification Server
// (Go NS) does not yet POST `miniapp_added` to the miniapp's webhookUrl, so
// the token never reaches this miniapp over the wire. As a temporary
// affordance the user can paste the token logged by the Startale app host
// (`[HOST] NS-issued token for senderId=…: <token>`) into the input below;
// it gets sent to the backend on /api/test-notification as `fallbackToken`.
// TODO(NS-team): remove once NS implements the miniapp webhook.
const FALLBACK_TOKEN_STORAGE_KEY = "mustard:dev:fallback-notification-token";

export function NotificationSection({ appName, accentColor, backendUrl, userAddress }: NotificationSectionProps) {
  const [status, setStatus] = useState<"idle" | "enabling" | "enabled" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<EventEntry[]>([]);
  const [fallbackToken, setFallbackToken] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(FALLBACK_TOKEN_STORAGE_KEY) ?? "";
  });
  const prefix = appName.toLowerCase();
  const logPrefix = `[MUSTARD][${prefix}]`;

  const tokenPreview = (token: string) => token.slice(0, 8);

  // Persist the pasted token across reloads so manual testing doesn't require
  // re-pasting every time.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (fallbackToken) {
      window.localStorage.setItem(FALLBACK_TOKEN_STORAGE_KEY, fallbackToken);
    } else {
      window.localStorage.removeItem(FALLBACK_TOKEN_STORAGE_KEY);
    }
  }, [fallbackToken]);

  // When the user has pasted a fallback token, treat the miniapp as
  // "enabled" for the purposes of UI gating — the host's webhook is the
  // only thing that would normally flip this, and it never arrives in the
  // current NS rollout. Without this, `handleEnable` polls forever and the
  // "Test Notification" button never appears.
  useEffect(() => {
    if (fallbackToken && status === "idle") {
      setStatus("enabled");
    }
  }, [fallbackToken, status]);

  const logEvent = useCallback((event: string, detail = "") => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    setEventLog((prev) => [{ event, detail, timestamp }, ...prev.slice(0, 9)]);
  }, []);

  const checkNotificationStatus = useCallback(async () => {
    if (!userAddress) return false;
    const res = await fetch(`${backendUrl}/api/notification-status?userAddress=${userAddress}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as { enabled?: boolean };
    console.log(`${logPrefix} checkNotificationStatus <- response`, {
      userAddress,
      enabled: Boolean(data.enabled),
    });
    return Boolean(data.enabled);
  }, [backendUrl, logPrefix, userAddress]);

  // Check if notifications are enabled for this user on mount
  useEffect(() => {
    if (!userAddress) return;
    checkNotificationStatus()
      .then((enabled) => {
        if (enabled) {
          setStatus("enabled");
        }
      })
      .catch((e) => {
        console.error(`${logPrefix} Failed to check notification status:`, e);
      });
  }, [checkNotificationStatus, logPrefix, userAddress]);

  useEffect(() => {
    const onAdded = (event: { notificationDetails?: { url: string; token: string } }) => {
      logEvent(
        "miniAppAdded",
        event.notificationDetails
          ? `token=${tokenPreview(event.notificationDetails.token)}... url=${event.notificationDetails.url}`
          : "no notification details",
      );
      setStatus("enabled");
    };

    const onAddRejected = (event: { reason?: string }) => {
      logEvent("miniAppAddRejected", event.reason ? String(event.reason) : "rejected");
    };

    const onRemoved = () => {
      logEvent("miniAppRemoved");
      setStatus("idle");
    };

    const onNotificationsEnabled = (event: { notificationDetails: { token: string } }) => {
      logEvent("notificationsEnabled", `token=${tokenPreview(event.notificationDetails.token)}...`);
      setStatus("enabled");
    };

    const onNotificationsDisabled = () => {
      logEvent("notificationsDisabled");
      setStatus("idle");
    };

    sdk.on("miniAppAdded", onAdded);
    sdk.on("miniAppAddRejected", onAddRejected);
    sdk.on("miniAppRemoved", onRemoved);
    sdk.on("notificationsEnabled", onNotificationsEnabled);
    sdk.on("notificationsDisabled", onNotificationsDisabled);

    return () => {
      sdk.removeListener("miniAppAdded", onAdded);
      sdk.removeListener("miniAppAddRejected", onAddRejected);
      sdk.removeListener("miniAppRemoved", onRemoved);
      sdk.removeListener("notificationsEnabled", onNotificationsEnabled);
      sdk.removeListener("notificationsDisabled", onNotificationsDisabled);
    };
  }, [logEvent]);

  const handleEnable = useCallback(async () => {
    setStatus("enabling");
    setError(null);
    try {
      console.log(`${logPrefix} handleEnable start`, { userAddress, backendUrl });
      const result = await sdk.actions.addMiniApp();
      console.log(`${logPrefix} handleEnable addMiniApp result`, {
        userAddress,
        hasNotificationDetails: Boolean(result.notificationDetails),
        sendUrl: result.notificationDetails?.url,
        tokenPreview: result.notificationDetails?.token ? tokenPreview(result.notificationDetails.token) : undefined,
      });

      if (!result.notificationDetails) {
        console.log(`${logPrefix} handleEnable addMiniApp returned no notificationDetails`, {
          userAddress,
        });
      }

      let enabled = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        console.log(`${logPrefix} handleEnable poll attempt`, {
          attempt: attempt + 1,
          userAddress,
        });
        enabled = await checkNotificationStatus();
        if (enabled) break;
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }

      if (!enabled) {
        console.log(`${logPrefix} handleEnable timed out waiting for registration`, {
          userAddress,
        });
        throw new Error("Notification registration did not complete yet");
      }

      console.log(`${logPrefix} handleEnable success`, { userAddress });
      setStatus("enabled");
    } catch (e) {
      console.error(`${logPrefix} Error in handleEnable:`, e);
      setError(e instanceof Error ? e.message : "Failed to enable notifications");
      setStatus("error");
    }
  }, [backendUrl, checkNotificationStatus, logPrefix, userAddress]);

  const handleSend = useCallback(async () => {
    if (!userAddress) return;
    setStatus("sending");
    setError(null);
    try {
      const trimmedFallbackToken = fallbackToken.trim();
      console.log(`${logPrefix} handleSend -> request`, {
        userAddress,
        backendUrl,
        hasFallbackToken: Boolean(trimmedFallbackToken),
      });
      const res = await fetch(`${backendUrl}/api/test-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress,
          // Backend ignores this when a webhook-stored token exists; only used
          // when `tokensByAddress` has no entry (NS hasn't called the webhook
          // yet) so the user can manually wire the token logged by the host.
          ...(trimmedFallbackToken ? { fallbackToken: trimmedFallbackToken } : {}),
        }),
      });
      console.log(`${logPrefix} handleSend <- response`, {
        status: res.status,
        ok: res.ok,
        userAddress,
      });
      if (!res.ok) {
        const errorData = (await res.json().catch(() => ({ error: "Unable to read response" }))) as { error?: string };
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }
      setStatus("sent");
      setTimeout(() => setStatus("enabled"), 2000);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Failed to send notification";
      console.error(`${logPrefix} Failed to send test notification:`, errorMessage);
      setError(`${errorMessage}. Check console for details.`);
      setStatus("error");
    }
  }, [backendUrl, fallbackToken, logPrefix, userAddress]);

  return (
    <div>
      <div style={{ marginBottom: "12px" }}>
        <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px" }}>Host Events</div>
        <div
          style={{
            backgroundColor: "#f3f4f6",
            borderRadius: "8px",
            padding: "12px",
            fontSize: "12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {eventLog.length > 0 ? (
            <div style={{ display: "grid", gap: "8px" }}>
              {eventLog.map((entry, index) => (
                <div key={`${entry.timestamp}-${entry.event}-${index}`}>
                  <div style={{ color: "#6b7280" }}>{entry.timestamp}</div>
                  <div>{entry.event}</div>
                  {entry.detail ? (
                    <div style={{ color: "#4b5563", wordBreak: "break-word" }}>{entry.detail}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: "#6b7280" }}>No host events received yet.</div>
          )}
        </div>
      </div>
      {/*
        Manual-test override: when the host's new Notification Server doesn't
        call the miniapp's webhook yet, paste the token logged by the Startale
        app host (`[HOST] NS-issued token for senderId=…: <token>`) below.
        Persisted in localStorage so it survives reloads. Remove this whole
        block once NS implements the webhook.
      */}
      <div
        style={{
          marginBottom: "12px",
          padding: "12px",
          border: "1px dashed #d1d5db",
          borderRadius: "8px",
          backgroundColor: "#fffbeb",
        }}
      >
        <label
          htmlFor="fallback-notification-token"
          style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "6px" }}
        >
          NS token (manual override)
        </label>
        <input
          id="fallback-notification-token"
          type="text"
          value={fallbackToken}
          onChange={(e) => setFallbackToken(e.target.value)}
          placeholder="Paste the token logged by the host"
          spellCheck={false}
          autoComplete="off"
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: "12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            border: "1px solid #d1d5db",
            borderRadius: "4px",
            boxSizing: "border-box",
          }}
        />
        <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "6px" }}>
          Used only when no webhook-stored token exists for this address. Saved locally.
        </div>
      </div>
      {status === "idle" || status === "error" ? (
        <button
          type="button"
          onClick={handleEnable}
          style={{
            padding: "8px 16px",
            backgroundColor: accentColor,
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "14px",
          }}
        >
          Enable Notifications
        </button>
      ) : status === "enabling" ? (
        <button type="button" disabled style={{ padding: "8px 16px", fontSize: "14px" }}>
          Enabling...
        </button>
      ) : (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            type="button"
            onClick={handleSend}
            disabled={status === "sending"}
            style={{
              padding: "8px 16px",
              backgroundColor: status === "sent" ? "#16a34a" : accentColor,
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "14px",
            }}
          >
            {status === "sending" ? "Sending..." : status === "sent" ? "Sent!" : "Test Notification"}
          </button>
        </div>
      )}
      {error && <div style={{ color: "red", fontSize: "12px", marginTop: "8px" }}>{error}</div>}
    </div>
  );
}
