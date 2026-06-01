import path from "node:path";

export const OUTPUT_DIR = ".service-parade";
export const CONFIG_CANDIDATES = ["service-parade.yaml", "service-parade.yml", "service-parade.json"];

export function resolveOutput(root: string, file: string): string {
  return path.join(root, OUTPUT_DIR, file);
}

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
