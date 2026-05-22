import { useEffect, useState } from "react";
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { soneium } from "wagmi/chains";

const NFT_CONTRACT = "0x7a181921b8976cE4a4997B134225d2E74E67797B" as const;
const NFT_ABI = [
  {
    inputs: [{ name: "to", type: "address" }],
    name: "mint",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const COOLDOWN_MS = 20000;

interface MintGalleryProps {
  address: `0x${string}`;
  storagePrefix: string;
  onMintSuccess?: () => void;
  emptySlotBg?: string;
  emptySlotBorder?: string;
}

export function MintGallery({
  address,
  storagePrefix,
  onMintSuccess,
  emptySlotBg = "rgba(0,0,0,0.1)",
  emptySlotBorder = "rgba(0,0,0,0.2)",
}: MintGalleryProps) {
  const { data: balance } = useReadContract({
    address: NFT_CONTRACT,
    abi: NFT_ABI,
    functionName: "balanceOf",
    args: [address],
    chainId: soneium.id,
  });

  const [localCount, setLocalCount] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(`${storagePrefix}-nft-count-${address}`);
      return saved ? Number.parseInt(saved, 10) : 0;
    } catch {
      return 0;
    }
  });

  // Sync: when on-chain balance loads, use the higher value
  useEffect(() => {
    if (balance !== undefined) {
      const onChain = Number(balance);
      setLocalCount((prev) => {
        const next = Math.max(prev, onChain);
        localStorage.setItem(`${storagePrefix}-nft-count-${address}`, next.toString());
        return next;
      });
    }
  }, [balance, address, storagePrefix]);

  const { data: tokenURI } = useReadContract({
    address: NFT_CONTRACT,
    abi: NFT_ABI,
    functionName: "tokenURI",
    args: [0n],
    chainId: soneium.id,
    query: {
      enabled: balance !== undefined && balance >= 1n,
    },
  });

  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const [lastMintTime, setLastMintTime] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem(`${storagePrefix}-last-mint-time`);
      return saved ? Number.parseInt(saved, 10) : null;
    } catch {
      return null;
    }
  });
  const [timeRemaining, setTimeRemaining] = useState<number>(0);

  // Cooldown timer
  useEffect(() => {
    if (!lastMintTime) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - lastMintTime));
      setTimeRemaining(remaining);
    }, 100);
    return () => clearInterval(interval);
  }, [lastMintTime]);

  const canMint = timeRemaining === 0;

  const handleMint = () => {
    writeContract({
      address: NFT_CONTRACT,
      abi: NFT_ABI,
      functionName: "mint",
      args: [address],
      chainId: soneium.id,
    });
  };

  // On successful mint: update count, save time, call callback
  useEffect(() => {
    if (isSuccess) {
      setLocalCount((prev) => {
        const next = prev + 1;
        localStorage.setItem(`${storagePrefix}-nft-count-${address}`, next.toString());
        return next;
      });
      const now = Date.now();
      setLastMintTime(now);
      localStorage.setItem(`${storagePrefix}-last-mint-time`, now.toString());
      onMintSuccess?.();
    }
  }, [isSuccess, address, storagePrefix, onMintSuccess]);

  const totalNfts = localCount;
  const nftCount = totalNfts === 0 ? 0 : totalNfts % 10 || 10;
  const formatTime = (ms: number) => `${Math.ceil(ms / 1000)}s`;

  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
        <button type="button" onClick={handleMint} disabled={isPending || isConfirming || !canMint}>
          {isPending || isConfirming ? "Minting..." : !canMint ? `Wait ${formatTime(timeRemaining)}` : "Mint NFT"}
        </button>
        <span style={{ fontSize: "13px", fontWeight: "500" }}>{totalNfts} minted</span>
      </div>

      {isSuccess && <div style={{ fontSize: "12px", marginTop: "8px" }}>NFT minted successfully!</div>}

      {error && <div style={{ color: "red", fontSize: "12px", marginTop: "8px" }}>Error: {error.message}</div>}

      {/* NFT Grid - 10 placeholders, 5 per row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: "8px",
          marginTop: "16px",
        }}
      >
        {Array.from({ length: 10 }, (_, i) => `nft-${i}`).map((nftKey, index) => (
          <div
            key={nftKey}
            style={{
              aspectRatio: "1",
              borderRadius: "8px",
              overflow: "hidden",
              backgroundColor: index < nftCount ? "transparent" : emptySlotBg,
              border: `2px solid ${index < nftCount ? "transparent" : emptySlotBorder}`,
            }}
          >
            {index < nftCount && tokenURI && (
              <img
                src={tokenURI}
                alt={`NFT ${index + 1}`}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
