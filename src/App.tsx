import { sdk } from "@farcaster/miniapp-sdk";
import { useCallback, useEffect, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSignMessage } from "wagmi";
import { Button } from "./Button";
import { CameraSection } from "./CameraSection";
import { ContextSection } from "./ContextSection";
import { MintGallery } from "./MintGallery";
import { NotificationSection } from "./NotificationSection";

const MUSTARD_BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";
const MUSTARD_LOG_PREFIX = "[MUSTARD][mustard]";

function SectionDivider({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "20px 0 12px" }}>
      <div style={{ flex: 1, height: "1px", backgroundColor: "rgba(255,255,255,0.2)" }} />
      <span
        style={{
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "rgba(255,255,255,0.5)",
        }}
      >
        {title}
      </span>
      <div style={{ flex: 1, height: "1px", backgroundColor: "rgba(255,255,255,0.2)" }} />
    </div>
  );
}

function App() {
  useEffect(() => {
    sdk.actions.ready();
  }, []);

  return (
    <div style={{ padding: "16px", maxWidth: "100%" }}>
      <h1 style={{ textAlign: "center", marginBottom: "24px", fontSize: "20px" }}>Mustard Mini App</h1>
      <ConnectMenu />
    </div>
  );
}

function ConnectMenu() {
  const { address, status, chain } = useConnection();
  const { mutate: connect, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const [starPoints, setStarPoints] = useState<number | null>(null);
  const [username, setUsername] = useState<string>("");
  const [pfpUrl, setPfpUrl] = useState<string>("");
  const [eoaWallets, setEoaWallets] = useState<string[]>([]);
  const [language, setLanguage] = useState<string>("");

  const startaleConnector = connectors.find((c) => c.name.toLowerCase() === "startale");

  // sdk.context is a Comlink proxy, so reading fields is async.
  useEffect(() => {
    (async () => {
      try {
        const context = (await sdk.context) as {
          startale?: { starPoints?: number; eoaWallets?: string[]; language?: string };
          user?: { username?: string; pfpUrl?: string };
        };
        if (context?.startale?.starPoints !== undefined) {
          setStarPoints(context.startale.starPoints);
        }
        if (context?.startale?.eoaWallets) {
          setEoaWallets(context.startale.eoaWallets);
        }
        if (context?.startale?.language) {
          setLanguage(context.startale.language);
        }
        if (context?.user?.username) {
          setUsername(context.user.username);
        }
        if (context?.user?.pfpUrl) {
          setPfpUrl(context.user.pfpUrl);
        }
      } catch (e) {
        console.error(`${MUSTARD_LOG_PREFIX} Failed to read context:`, e);
      }
    })();
  }, []);

  if (status === "connected") {
    return (
      <div style={{ fontSize: "14px" }}>
        <Button onClick={() => disconnect()} style={{ marginBottom: "4px" }}>
          Disconnect Wallet
        </Button>

        <SectionDivider title="Wallet Info" />
        <div style={{ marginBottom: "8px", fontWeight: "500" }}>Connected smart account:</div>
        <div style={{ wordBreak: "break-all", marginBottom: "12px", fontSize: "11px" }}>{address}</div>
        <div style={{ marginBottom: "4px" }}>Chain: {chain?.name}</div>

        <SectionDivider title="Context" />
        <ContextSection
          starPoints={starPoints}
          username={username}
          pfpUrl={pfpUrl}
          eoaWallets={eoaWallets}
          language={language}
        />

        <SectionDivider title="Minting" />
        {address && <MintGalleryWithNotifications address={address} />}

        <SectionDivider title="Notifications" />
        {address && <NotificationSection appName="Mustard" backendUrl={MUSTARD_BACKEND_URL} userAddress={address} />}

        <SectionDivider title="Camera" />
        <CameraSection />

        <SectionDivider title="Message Signing" />
        <SignButton />
      </div>
    );
  }

  return (
    <div style={{ fontSize: "14px" }}>
      <div style={{ marginBottom: "8px" }}>Status: {status}</div>
      <div style={{ marginBottom: "8px" }}>Chain: {chain?.name}</div>

      {startaleConnector ? (
        <Button
          onClick={() => {
            connect({ connector: startaleConnector });
          }}
          disabled={status === "connecting"}
          style={{ marginBottom: "12px" }}
        >
          {status === "connecting" ? "Connecting..." : "Connect with Startale"}
        </Button>
      ) : (
        <div style={{ color: "#92400e", fontSize: "12px", marginBottom: "12px" }}>Startale connector not found</div>
      )}

      {connectError && (
        <div style={{ color: "red", marginTop: "10px", fontSize: "12px" }}>Error: {connectError.message}</div>
      )}
    </div>
  );
}

function MintGalleryWithNotifications({ address }: { address: `0x${string}` }) {
  const handleMintSuccess = useCallback(() => {
    console.log(`${MUSTARD_LOG_PREFIX} mint success, notifying backend for address ${address}`);
    fetch(`${MUSTARD_BACKEND_URL}/api/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userAddress: address }),
    })
      .then((res) => {
        console.log(`${MUSTARD_LOG_PREFIX} /api/mint response: ${res.status}`);
        return res.json();
      })
      .then((data) => console.log(`${MUSTARD_LOG_PREFIX} /api/mint result:`, data))
      .catch((e) => console.error(`${MUSTARD_LOG_PREFIX} Failed to notify backend:`, e));
  }, [address]);

  return <MintGallery address={address} storagePrefix="mustard" onMintSuccess={handleMintSuccess} />;
}

function SignButton() {
  const { mutate: signMessage, isPending, data, error } = useSignMessage();

  return (
    <div>
      <Button onClick={() => signMessage({ message: "hello world" })} disabled={isPending}>
        {isPending ? "Signing..." : "Sign message"}
      </Button>
      {data && (
        <div style={{ marginTop: "12px" }}>
          <div style={{ marginBottom: "8px", fontWeight: "500", fontSize: "14px" }}>Signature</div>
          <div style={{ wordBreak: "break-all", fontSize: "11px", fontFamily: "monospace", lineHeight: "1.4" }}>
            {data}
          </div>
        </div>
      )}
      {error && (
        <div style={{ marginTop: "12px" }}>
          <div style={{ marginBottom: "8px", fontWeight: "500", fontSize: "14px" }}>Error</div>
          <div style={{ color: "red", fontSize: "12px" }}>{error.message}</div>
        </div>
      )}
    </div>
  );
}

export default App;
