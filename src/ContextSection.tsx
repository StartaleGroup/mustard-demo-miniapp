import type { ReactNode } from "react";
import { truncateAddress } from "./truncateAddress";

interface ContextSectionProps {
  starPoints: number | null;
  username?: string;
  pfpUrl?: string;
  eoaWallets: string[];
  language?: string;
}

function ContextRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <tr>
      <td
        style={{
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "rgba(0,0,0,0.6)",
          whiteSpace: "nowrap",
          padding: "8px 12px 8px 0",
          verticalAlign: "middle",
        }}
      >
        {label}
      </td>
      <td style={{ fontSize: "13px", padding: "8px 0", verticalAlign: "middle" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>{value}</div>
      </td>
    </tr>
  );
}

function ContextSeparator() {
  return (
    <tr>
      <td colSpan={2} style={{ padding: 0 }}>
        <div style={{ height: "1px", backgroundColor: "rgba(0,0,0,0.25)" }} />
      </td>
    </tr>
  );
}

export function ContextSection({ starPoints, username, pfpUrl, eoaWallets, language }: ContextSectionProps) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {username && <ContextRow label="Username" value={username} />}
        {pfpUrl && (
          <>
            {username && <ContextSeparator />}
            <ContextRow
              label="Avatar"
              value={
                <img
                  src={pfpUrl}
                  alt={username || "User"}
                  style={{ width: "32px", height: "32px", borderRadius: "50%", objectFit: "cover" }}
                />
              }
            />
          </>
        )}
        {(username || pfpUrl) && <ContextSeparator />}
        <ContextRow label="Star Points" value={starPoints !== null ? starPoints.toLocaleString() : "—"} />
        <ContextSeparator />
        <ContextRow
          label={`EOA Wallet${eoaWallets.length > 1 ? "s" : ""}`}
          value={
            eoaWallets.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {eoaWallets.map((wallet) => (
                  <span key={wallet} style={{ fontFamily: "monospace", fontSize: "12px" }}>
                    {truncateAddress(wallet)}
                  </span>
                ))}
              </div>
            ) : (
              "—"
            )
          }
        />
        <ContextSeparator />
        <ContextRow label="Language" value={language || "—"} />
      </tbody>
    </table>
  );
}
