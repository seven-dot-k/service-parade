import path from "node:path";

export const OUTPUT_DIR = ".multirepo";
export const CONFIG_CANDIDATES = ["multirepo.yaml", "multirepo.yml", "multirepo.json"];

export function resolveOutput(root: string, file: string): string {
  return path.join(root, OUTPUT_DIR, file);
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
