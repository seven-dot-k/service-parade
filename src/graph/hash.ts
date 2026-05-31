import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableId(prefix: string, ...parts: Array<string | number | null>): string {
  return `${prefix}:${sha256(parts.map((part) => String(part ?? "")).join("\u0000")).slice(0, 24)}`;
}
