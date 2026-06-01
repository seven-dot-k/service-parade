#!/usr/bin/env node
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServiceParadeMcpServer, type ServiceParadeMcpOptions } from "./server.ts";

export type ServiceParadeStdioOptions = ServiceParadeMcpOptions & {
  stdin?: Readable;
  stdout?: Writable;
};

export async function startServiceParadeStdioServer(options: ServiceParadeStdioOptions): Promise<void> {
  const server = createServiceParadeMcpServer(options);
  await server.connect(new StdioServerTransport(options.stdin, options.stdout));
}

function parseArgs(argv: string[]): ServiceParadeMcpOptions {
  let root = process.cwd();
  let config: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--root" && token !== "--config") {
      throw new Error(`Unknown argument "${token}". Usage: node src/mcp/stdio.ts [--root <workspace>] [--config <file>]`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for "${token}".`);
    }
    if (token === "--root") {
      root = value;
    } else {
      config = value;
    }
    index += 1;
  }
  return { root, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServiceParadeStdioServer(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
