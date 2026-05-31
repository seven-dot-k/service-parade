import Parser from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";
import TypeScript from "tree-sitter-typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".cs"]);

export function supportsSource(file: string): boolean {
  return sourceExtensions.has(extension(file));
}

export function supportsAnalysis(file: string): boolean {
  return supportsSource(file) || extension(file) === ".json";
}

export function parseSource(file: string, content: string): Parser.Tree | null {
  const ext = extension(file);
  if (!sourceExtensions.has(ext)) {
    return null;
  }
  try {
    const parser = new Parser();
    parser.setLanguage(ext === ".cs" ? CSharp : ext === ".tsx" || ext === ".jsx" ? TypeScript.tsx : TypeScript.typescript);
    return parser.parse(content);
  } catch {
    return null;
  }
}

function extension(file: string): string {
  const match = file.toLowerCase().match(/\.[^.]+$/);
  return match?.[0] ?? "";
}
