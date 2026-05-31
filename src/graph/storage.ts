import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { GraphFact, LinkDecision, PendingLink } from "./types.ts";

export class GraphStorage {
  readonly db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        analyzed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS analysis_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        file_count INTEGER NOT NULL,
        fact_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_links (
        id TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS link_decisions (
        signature TEXT PRIMARY KEY,
        decision TEXT NOT NULL,
        target_endpoint_id TEXT,
        decided_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind);
      CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_links(status);
    `);
  }

  close(): void {
    this.db.close();
  }

  getFileHashes(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, content_hash FROM files ORDER BY id").all() as Array<{ id: string; content_hash: string }>;
    return new Map(rows.map((row) => [row.id, row.content_hash]));
  }

  replaceFile(file: { id: string; serviceId: string; path: string; contentHash: string }, facts: GraphFact[]): void {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM facts WHERE file_id = ?").run(file.id);
      this.db.prepare(`
        INSERT INTO files(id, service_id, path, content_hash, analyzed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          service_id = excluded.service_id,
          path = excluded.path,
          content_hash = excluded.content_hash,
          analyzed_at = excluded.analyzed_at
      `).run(file.id, file.serviceId, file.path, file.contentHash, new Date().toISOString());
      const insertFact = this.db.prepare("INSERT INTO facts(id, file_id, kind, data) VALUES (?, ?, ?, ?)");
      for (const fact of facts) {
        insertFact.run(fact.id, file.id, fact.kind, JSON.stringify(fact));
      }
    });
    run();
  }

  purgeMissingFiles(currentIds: Set<string>): number {
    const rows = this.db.prepare("SELECT id FROM files ORDER BY id").all() as Array<{ id: string }>;
    const remove = this.db.prepare("DELETE FROM files WHERE id = ?");
    let count = 0;
    const run = this.db.transaction(() => {
      for (const row of rows) {
        if (!currentIds.has(row.id)) {
          remove.run(row.id);
          count += 1;
        }
      }
    });
    run();
    return count;
  }

  allFacts(): GraphFact[] {
    const rows = this.db.prepare("SELECT data FROM facts ORDER BY id").all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as GraphFact);
  }

  recordRun(manifestHash: string, fileCount: number, factCount: number): void {
    this.db.prepare("INSERT INTO analysis_runs(id, created_at, manifest_hash, file_count, fact_count) VALUES (?, ?, ?, ?, ?)")
      .run(`${Date.now()}-${manifestHash.slice(0, 12)}`, new Date().toISOString(), manifestHash, fileCount, factCount);
    this.setMeta("index_manifest_hash", manifestHash);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  replacePendingLinks(items: PendingLink[]): void {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM pending_links").run();
      const insert = this.db.prepare("INSERT INTO pending_links(id, signature, status, data) VALUES (?, ?, ?, ?)");
      for (const item of items) {
        insert.run(item.id, item.signature, item.reviewStatus, JSON.stringify(item));
      }
    });
    run();
  }

  listPendingLinks(): PendingLink[] {
    const rows = this.db.prepare("SELECT data FROM pending_links WHERE status = 'pending_review' ORDER BY id").all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as PendingLink);
  }

  getPendingLink(id: string): PendingLink | undefined {
    const row = this.db.prepare("SELECT data FROM pending_links WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as PendingLink : undefined;
  }

  getDecisions(): Map<string, LinkDecision> {
    const rows = this.db.prepare(`
      SELECT signature, decision, target_endpoint_id, decided_by, updated_at
      FROM link_decisions ORDER BY signature
    `).all() as Array<{
      signature: string;
      decision: "approved" | "rejected";
      target_endpoint_id: string | null;
      decided_by: "human" | "llm";
      updated_at: string;
    }>;
    return new Map(rows.map((row) => [row.signature, {
      signature: row.signature,
      decision: row.decision,
      targetEndpointId: row.target_endpoint_id,
      decidedBy: row.decided_by,
      updatedAt: row.updated_at
    }]));
  }

  saveDecision(decision: LinkDecision): void {
    this.db.prepare(`
      INSERT INTO link_decisions(signature, decision, target_endpoint_id, decided_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(signature) DO UPDATE SET
        decision = excluded.decision,
        target_endpoint_id = excluded.target_endpoint_id,
        decided_by = excluded.decided_by,
        updated_at = excluded.updated_at
    `).run(decision.signature, decision.decision, decision.targetEndpointId, decision.decidedBy, decision.updatedAt);
  }
}
