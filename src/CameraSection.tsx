import { sdk } from "@farcaster/miniapp-sdk";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";

const LOG_PREFIX = "[MUSTARD][camera]";
const ACCENT = "#92400e";
const METER_SEGMENTS = 20;
const METER_KEYS = Array.from({ length: METER_SEGMENTS }, (_, i) => `seg-${i}`);

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
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  // 0..1 mic loudness, drives the level meter.
  const [level, setLevel] = useState(0);

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

  // Read mic loudness (RMS) on each frame and push it to the meter.
  const startMeter = (stream: MediaStream) => {
    const AudioCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const audioContext = new AudioCtor();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (const sample of data) {
        const norm = (sample - 128) / 128;
        sumSquares += norm * norm;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      // Speech RMS is small; scale up and clamp so the meter is responsive.
      setLevel(Math.min(1, rms * 2.5));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const stop = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLevel(0);
    setStatus("idle");
  };

  // Release camera/mic if the component unmounts while live. Inlined (not `stop`)
  // so it touches only refs — no state updates on an unmounted component.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      audioContextRef.current?.close().catch(() => {});
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    },
    [],
  );

  const start = async () => {
    setError(null);
    setStatus("starting");
    try {
      await requestHostPermission();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      startMeter(stream);
      setStatus("live");
    } catch (e) {
      console.error(`${LOG_PREFIX} camera/mic start failed:`, e);
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setStatus(denied ? "denied" : "error");
      setError(e instanceof Error ? e.message : "Failed to start camera/mic");
    }
  };

  const isLive = status === "live";
  const disabled = supported === false || status === "starting";
  const litSegments = Math.round(level * METER_SEGMENTS);

  return (
    <div style={{ fontSize: "14px" }}>
      <Button onClick={isLive ? stop : start} disabled={disabled} style={{ marginBottom: "12px" }}>
        {status === "starting" ? "Starting..." : isLive ? "Stop camera & mic" : "Start camera & mic"}
      </Button>

      {supported === false && (
        <div style={{ color: ACCENT, fontSize: "12px", marginBottom: "8px" }}>Camera not supported by host</div>
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
            {status === "denied" ? "Permission denied" : status === "error" ? "Camera error" : "Camera off"}
          </span>
        )}
      </div>

      {isLive && (
        <div style={{ marginTop: "10px" }}>
          <div
            style={{
              fontSize: "11px",
              color: "rgba(255,255,255,0.6)",
              marginBottom: "4px",
            }}
          >
            Mic level
          </div>
          <div aria-label="Microphone input level" style={{ display: "flex", gap: "3px" }}>
            {METER_KEYS.map((key, i) => (
              <div
                key={key}
                style={{
                  flex: 1,
                  height: "14px",
                  borderRadius: "2px",
                  backgroundColor: i < litSegments ? "#1f2937" : "rgba(0,0,0,0.15)",
                  transition: "background-color 60ms linear",
                }}
              />
            ))}
          </div>
        </div>
      )}

      {error && status !== "denied" && <div style={{ color: "red", fontSize: "12px", marginTop: "8px" }}>{error}</div>}
    </div>
  );
}
