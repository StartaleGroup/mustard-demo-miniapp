import type { ButtonHTMLAttributes } from "react";

const ACCENT = "#92400e";

/**
 * The single button style for the app. Every button looks the same — only
 * enabled vs. disabled differs. Layout spacing (e.g. margins) can be passed
 * via `style`; visual styling is fixed.
 */
export function Button({ disabled, style, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        padding: "10px 20px",
        backgroundColor: ACCENT,
        color: "white",
        border: "none",
        borderRadius: "6px",
        fontSize: "14px",
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
      {...props}
    />
  );
}
