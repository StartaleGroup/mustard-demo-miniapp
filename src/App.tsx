import { sdk } from "@farcaster/miniapp-sdk";
import { useCallback, useEffect, useState } from "react";
import {
  useChainId,
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  useSignMessage,
  useSignTypedData,
} from "wagmi";
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

        <SectionDivider title="Typed Data Signing" />
        <SignTypedDataButton />

        <SectionDivider title="Permit Signing" />
        <SignPermitButton />
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

// Soneium USDC.e — a real token so the wallet can resolve symbol/decimals on-chain.
const PERMIT_TOKEN = "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369";
// Canonical Permit2 contract, used as a realistic spender.
const PERMIT_SPENDER = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX_UINT256 = 2n ** 256n - 1n;

function SignPermitButton() {
  const chainId = useChainId();
  const { address } = useConnection();
  const { mutate: signTypedData, isPending, data, error } = useSignTypedData();

  // EIP-2612 Permit — canonical struct layout, so the wallet's permit
  // detection should render the human-readable spending-permission card.
  const onSign = (unlimited: boolean) => {
    signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId,
        verifyingContract: PERMIT_TOKEN,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: address ?? "0x0000000000000000000000000000000000000000",
        spender: PERMIT_SPENDER,
        value: unlimited ? MAX_UINT256 : 100_000_000n, // 100 USDC (6 decimals)
        nonce: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
      },
    });
  };

  return (
    <div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" onClick={() => onSign(false)} disabled={isPending}>
          {isPending ? "Signing..." : "Sign permit (100 USDC)"}
        </button>
        <button type="button" onClick={() => onSign(true)} disabled={isPending}>
          {isPending ? "Signing..." : "Sign unlimited permit"}
        </button>
      </div>
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

function SignTypedDataButton() {
  const chainId = useChainId();
  const { mutate: signTypedData, isPending, data, error } = useSignTypedData();

  const onSign = () => {
    signTypedData({
      domain: {
        name: "Mustard Mini App",
        version: "1",
        chainId,
      },
      types: {
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      message: {
        from: { name: "Alice", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    });
  };

  return (
    <div>
      <button type="button" onClick={onSign} disabled={isPending}>
        {isPending ? "Signing..." : "Sign typed data"}
      </button>
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
