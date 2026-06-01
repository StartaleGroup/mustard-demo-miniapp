import { sdk } from "@farcaster/miniapp-sdk";
import { useCallback, useEffect, useState } from "react";

type EventEntry = { event: string; detail: string; timestamp: string };

// NS tokens share a common prefix (ntf_<ULID>.sk_live_...), so the trailing
// chars are what actually distinguish one token from another.
const tokenPreview = (token: string) => `...${token.slice(-8)}`;

interface NotificationSectionProps {
  appName: string;
  accentColor: string;
  backendUrl: string;
  userAddress: string;
}

export function NotificationSection({ appName, accentColor, backendUrl, userAddress }: NotificationSectionProps) {
  const [hasToken, setHasToken] = useState(false);
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<EventEntry[]>([]);
  const prefix = appName.toLowerCase();
  const logPrefix = `[MUSTARD][${prefix}]`;

  const logEvent = useCallback((event: string, detail = "") => {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
    setEventLog((prev) => [{ event, detail, timestamp }, ...prev.slice(0, 9)]);
  }, []);

  // Poll the miniapp's own backend for `enabled` state so the UI reflects
  // /webhook arrivals (host → backend) even when the SDK doesn't fire an
  // event in this browser. Each transition is logged to Host Events.
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastEnabled: boolean | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`${backendUrl}/api/notification-status?userAddress=${userAddress}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { enabled?: boolean };
        if (cancelled) return;
        const enabled = Boolean(data.enabled);
        if (lastEnabled === null) {
          if (enabled) setHasToken(true);
        } else if (lastEnabled !== enabled) {
          setHasToken(enabled);
          logEvent(
            enabled ? "webhook:miniapp_added" : "webhook:miniapp_removed",
            `backend status -> enabled=${enabled}`,
          );
        }
        lastEnabled = enabled;
      } catch (e) {
        console.error(`${logPrefix} Failed to poll notification status:`, e);
      }
      if (!cancelled) timeoutId = setTimeout(tick, 3000);
    };

    tick();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [backendUrl, logEvent, logPrefix, userAddress]);

  useEffect(() => {
    const onAdded = (event: { notificationDetails?: { url: string; token: string } }) => {
      logEvent(
        "miniAppAdded",
        event.notificationDetails
          ? `token=${tokenPreview(event.notificationDetails.token)} url=${event.notificationDetails.url}`
          : "no notification details",
      );
      if (event.notificationDetails) {
        setHasToken(true);
      }
    };

    const onAddRejected = (event: { reason?: string }) => {
      logEvent("miniAppAddRejected", event.reason ? String(event.reason) : "rejected");
    };

    const onRemoved = () => {
      logEvent("miniAppRemoved");
      setHasToken(false);
    };

    const onNotificationsEnabled = (event: { notificationDetails: { token: string } }) => {
      logEvent("notificationsEnabled", `token=${tokenPreview(event.notificationDetails.token)}`);
      setHasToken(true);
    };

    const onNotificationsDisabled = () => {
      logEvent("notificationsDisabled");
      setHasToken(false);
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

  const handleSend = useCallback(async () => {
    if (!userAddress) return;
    setSendState("sending");
    setError(null);
    try {
      console.log(`${logPrefix} handleSend -> request`, { userAddress, backendUrl });
      const res = await fetch(`${backendUrl}/api/test-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userAddress }),
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
      setSendState("sent");
      setTimeout(() => setSendState("idle"), 2000);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Failed to send notification";
      console.error(`${logPrefix} Failed to send test notification:`, errorMessage);
      setError(`${errorMessage}. Check console for details.`);
      setSendState("error");
    }
  }, [backendUrl, logPrefix, userAddress]);

  const testDisabled = !hasToken || sendState === "sending";

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
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={handleSend}
          disabled={testDisabled}
          style={{
            padding: "8px 16px",
            backgroundColor: sendState === "sent" ? "#16a34a" : accentColor,
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: testDisabled ? "not-allowed" : "pointer",
            fontSize: "14px",
            opacity: testDisabled ? 0.5 : 1,
          }}
        >
          {sendState === "sending" ? "Sending..." : sendState === "sent" ? "Sent!" : "Test Notification"}
        </button>
      </div>
      {error && <div style={{ color: "red", fontSize: "12px", marginTop: "8px" }}>{error}</div>}
    </div>
  );
}
