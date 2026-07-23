import { Fragment, type ReactNode } from "react";

function UrlParamRow({ label, value }: { label: string; value: ReactNode }) {
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
        <div style={{ display: "flex", justifyContent: "flex-end", wordBreak: "break-all" }}>{value}</div>
      </td>
    </tr>
  );
}

function UrlParamSeparator() {
  return (
    <tr>
      <td colSpan={2} style={{ padding: 0 }}>
        <div style={{ height: "1px", backgroundColor: "rgba(0,0,0,0.25)" }} />
      </td>
    </tr>
  );
}

export function UrlParamsSection() {
  const params = Array.from(new URLSearchParams(window.location.search).entries());

  if (params.length === 0) {
    return (
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <UrlParamRow label="Params" value="—" />
        </tbody>
      </table>
    );
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {params.map(([key, value], index) => (
          <Fragment key={`${key}-${index}`}>
            {index > 0 && <UrlParamSeparator />}
            <UrlParamRow label={key} value={value || "—"} />
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
