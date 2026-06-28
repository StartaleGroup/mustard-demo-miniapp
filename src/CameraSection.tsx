import { sdk } from "@farcaster/miniapp-sdk";
import { useEffect, useRef, useState } from "react";

const LOG_PREFIX = "[MUSTARD][camera]";
const ACCENT = "#92400e";

type Status = "idle" | "starting" | "live" | "denied" | "error";


async function requestHostPermission(): Promise<void> {
  const actions = sdk.actions as {
    requestCameraAndMicrophoneAccess?: () => Promise<void>;
  };
  if (typeof actions.requestCameraAndMicrophoneAccess === "function") {
    await actions.requestCameraAndMicrophoneAccess();
  }
}

export function CameraSection() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);

  // The host advertises camera support via context.features. When false we
  // disable the button instead of letting getUserMedia fail opaquely.
  useEffect(() => {
    (async () => {
      try {
        const context = (await sdk.context) as {
          features?: { cameraAndMicrophoneAccess?: boolean };
        };
        setSupported(context?.features?.cameraAndMicrophoneAccess ?? false);
      } catch {
        setSupported(false);
      }
    })();
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("idle");
  };

  // Release the camera if the component unmounts while live.
  useEffect(() => stopCamera, []);

  const startCamera = async () => {
    setError(null);
    setStatus("starting");
    try {
      await requestHostPermission();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setStatus("live");
    } catch (e) {
      console.error(`${LOG_PREFIX} camera start failed:`, e);
      const denied =
        e instanceof DOMException &&
        (e.name === "NotAllowedError" || e.name === "SecurityError");
      setStatus(denied ? "denied" : "error");
      setError(e instanceof Error ? e.message : "Failed to start camera");
    }
  };

  const isLive = status === "live";
  const disabled = supported === false || status === "starting";

  return (
    <div style={{ fontSize: "14px" }}>
      <button
        type="button"
        onClick={isLive ? stopCamera : startCamera}
        disabled={disabled}
        style={{
          padding: "8px 16px",
          backgroundColor: isLive ? "#dc2626" : ACCENT,
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: "14px",
          opacity: disabled ? 0.5 : 1,
          marginBottom: "12px",
        }}
      >
        {status === "starting"
          ? "Starting..."
          : isLive
            ? "Stop camera"
            : "Start camera"}
      </button>

      {supported === false && (
        <div style={{ color: ACCENT, fontSize: "12px", marginBottom: "8px" }}>
          Camera not supported by host
        </div>
      )}

      <div
        style={{
          width: "240px",
          maxWidth: "100%",
          height: "180px",
          borderRadius: "8px",
          overflow: "hidden",
          backgroundColor: "rgba(0,0,0,0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: isLive ? "block" : "none",
          }}
        />
        {!isLive && (
          <span style={{ color: "rgba(255,255,255,0.5)", fontSize: "12px" }}>
            {status === "denied"
              ? "Permission denied"
              : status === "error"
                ? "Camera error"
                : "Camera off"}
          </span>
        )}
      </div>

      {error && status !== "denied" && (
        <div style={{ color: "red", fontSize: "12px", marginTop: "8px" }}>
          {error}
        </div>
      )}
    </div>
  );
}
