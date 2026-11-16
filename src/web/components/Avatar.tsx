import type { CSSProperties } from "react";
import { Bookmark } from "lucide-react";
import { initials } from "../lib/format";

interface Props {
  name: string;
  hue: number;
  size?: number;
  saved?: boolean;
  online?: boolean;
}

/** Telegram-style colored circle with initials (no uploads → nothing to leak or moderate). */
export function Avatar({ name, hue, size = 54, saved, online }: Props) {
  const style = { "--h": hue, width: size, height: size, fontSize: size * 0.4 } as CSSProperties;
  return (
    <span className={`avatar${saved ? " avatar--saved" : ""}`} style={style} aria-hidden="true">
      {saved ? <Bookmark size={size * 0.45} fill="currentColor" strokeWidth={1.5} /> : initials(name)}
      {online && <span className="avatar__online" />}
    </span>
  );
}
