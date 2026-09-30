import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { normalizeValue } from "./normalize.js";
// Type-only import: fully erased at compile time, so it never becomes a
// runtime import statement (see the createRequire note below).
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type {
  Claim,
  Conflict,
  ConflictWithClaims,
  RecordClaimInput,
  RecordClaimResult,
} from "./types.js";

// `node:sqlite` is loaded via createRequire (a real, static-analysis-proof
// runtime require) rather than a top-level `import ... from "node:sqlite"`.
// node:sqlite is a *prefix-only* Node builtin (there is no bare "sqlite"
// package) added in recent Node versions; some bundlers/test runners
// (observed with the Vite/vite-node version this project's Vitest pulls in)
// still strip the "node:" prefix when "externalizing" an import and then try
// to load a nonexistent bare "sqlite" package. Routing through
// `createRequire` sidesteps that static import-rewriting entirely, since it
// is a plain runtime function call, not an import Vite's analyzer rewrites.
type SqliteModule = typeof import("node:sqlite");
const { DatabaseSync }: SqliteModule = createRequire(import.meta.url)("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  file TEXT,
  confidence REAL NOT NULL,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);

CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  prior_claim_id TEXT NOT NULL,
  new_claim_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_claim_id TEXT,
  resolution_note TEXT,
  FOREIGN KEY (prior_claim_id) REFERENCES claims(id),
  FOREIGN KEY (new_claim_id) REFERENCES claims(id)
);

CREATE INDEX IF NOT EXISTS idx_conflicts_subject ON conflicts(subject);
CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved);
`;

interface ClaimRow {
  id: string;
  subject: string;
  value: string;
  normalized_value: string;
  file: string | null;
  confidence: number;
  agent: string;
  created_at: string;
}

interface ConflictRow {
  id: string;
  subject: string;
  prior_claim_id: string;
  new_claim_id: string;
  created_at: string;
  resolved: number;
  resolved_at: string | null;
  resolved_claim_id: string | null;
  resolution_note: string | null;
}

function claimFromRow(row: ClaimRow): Claim {
  return {
    id: row.id,
    subject: row.subject,
    value: row.value,
    normalizedValue: row.normalized_value,
    file: row.file,
    confidence: row.confidence,
    agent: row.agent,
    createdAt: row.created_at,
  };
}

function conflictFromRow(row: ConflictRow): Conflict {
  return {
    id: row.id,
    subject: row.subject,
    priorClaimId: row.prior_claim_id,
    newClaimId: row.new_claim_id,
    createdAt: row.created_at,
    resolved: row.resolved === 1,
    resolvedAt: row.resolved_at,
    resolvedClaimId: row.resolved_claim_id,
    resolutionNote: row.resolution_note,
  };
}

export class ClaimNotFoundError extends Error {}
export class ConflictNotFoundError extends Error {}
export class ResolveError extends Error {}

/**
 * BlackboardStore is the single point of access to the SQLite-backed claim
 * and conflict store. Storage backend: Node's built-in `node:sqlite`
 * (DatabaseSync), available unflagged in Node >= 22.5 (we target >=22.5,
 * developed/tested on Node 24). We use node:sqlite rather than
 * better-sqlite3 because it is a real SQLite binding that ships with Node
 * itself, needs no native module compilation/prebuilt binary download, and
 * is therefore the most reliable choice across contributor machines and CI.
 * A flat JSON file was not needed since node:sqlite installs with zero
 * friction.
 */
export class BlackboardStore {
  private db: DatabaseSyncType;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // Without a busy timeout, a second concurrent `blackboard` process
    // hitting this store while a write is in flight gets an immediate,
    // uncaught SQLITE_BUSY ("database is locked") instead of waiting for
    // the lock to clear -- fatal for this tool's actual use case (a fleet
    // of parallel agent processes all writing to the same store.db).
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Record a new claim. If prior claims already exist for this subject, the
   * new claim is compared (after normalization: trim/lowercase/collapse
   * whitespace) against the most recently recorded prior claim for that
   * subject. An exact match after normalization -> no conflict. Anything
   * else -> a Conflict row is created referencing both claims side by side.
   */
  recordClaim(input: RecordClaimInput): RecordClaimResult {
    const subject = input.subject.trim();
    if (!subject) {
      throw new Error("subject must be a non-empty string");
    }
    const value = input.value;
    if (!value || !value.trim()) {
      throw new Error("value must be a non-empty string");
    }
    const confidence = input.confidence ?? 0.8;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("confidence must be a number between 0 and 1");
    }
    const agent = input.agent && input.agent.trim() ? input.agent.trim() : "unknown";
    const file = input.file ?? null;

    const priorRow = this.db
      .prepare(
        `SELECT * FROM claims WHERE subject = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(subject) as ClaimRow | undefined;

    const claim: Claim = {
      id: randomUUID(),
      subject,
      value,
      normalizedValue: normalizeValue(value),
      file,
      confidence,
      agent,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO claims (id, subject, value, normalized_value, file, confidence, agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        claim.id,
        claim.subject,
        claim.value,
        claim.normalizedValue,
        claim.file,
        claim.confidence,
        claim.agent,
        claim.createdAt
      );

    let conflict: ConflictWithClaims | null = null;
    if (priorRow && priorRow.normalized_value !== claim.normalizedValue) {
      const priorClaim = claimFromRow(priorRow);
      const conflictRecord: Conflict = {
        id: randomUUID(),
        subject,
        priorClaimId: priorClaim.id,
        newClaimId: claim.id,
        createdAt: new Date().toISOString(),
        resolved: false,
        resolvedAt: null,
        resolvedClaimId: null,
        resolutionNote: null,
      };
      this.db
        .prepare(
          `INSERT INTO conflicts (id, subject, prior_claim_id, new_claim_id, created_at, resolved)
           VALUES (?, ?, ?, ?, ?, 0)`
        )
        .run(
          conflictRecord.id,
          conflictRecord.subject,
          conflictRecord.priorClaimId,
          conflictRecord.newClaimId,
          conflictRecord.createdAt
        );
      conflict = { ...conflictRecord, priorClaim, newClaim: claim };
    }

    return { claim, conflict };
  }

  /** Full claim history for a subject, oldest first. */
  listClaims(subject: string): Claim[] {
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE subject = ? ORDER BY created_at ASC, rowid ASC`)
      .all(subject.trim()) as unknown as ClaimRow[];
    return rows.map(claimFromRow);
  }

  getClaim(claimId: string): Claim | null {
    const row = this.db.prepare(`SELECT * FROM claims WHERE id = ?`).get(claimId) as
      | ClaimRow
      | undefined;
    return row ? claimFromRow(row) : null;
  }

  /** All subjects that currently have at least one recorded claim. */
  listSubjects(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT subject FROM claims ORDER BY subject ASC`)
      .all() as { subject: string }[];
    return rows.map((r) => r.subject);
  }

  private hydrateConflict(row: ConflictRow): ConflictWithClaims {
    const conflict = conflictFromRow(row);
    const priorClaim = this.getClaim(conflict.priorClaimId);
    const newClaim = this.getClaim(conflict.newClaimId);
    if (!priorClaim || !newClaim) {
      throw new ClaimNotFoundError(
        `Conflict ${conflict.id} references a missing claim (data corruption?)`
      );
    }
    return { ...conflict, priorClaim, newClaim };
  }

  /** List conflicts. By default only unresolved ones; pass includeResolved to get all. */
  listConflicts(options: { includeResolved?: boolean } = {}): ConflictWithClaims[] {
    const rows = options.includeResolved
      ? (this.db.prepare(`SELECT * FROM conflicts ORDER BY created_at ASC`).all() as unknown as ConflictRow[])
      : (this.db
          .prepare(`SELECT * FROM conflicts WHERE resolved = 0 ORDER BY created_at ASC`)
          .all() as unknown as ConflictRow[]);
    return rows.map((row) => this.hydrateConflict(row));
  }

  getConflict(conflictId: string): ConflictWithClaims | null {
    const row = this.db.prepare(`SELECT * FROM conflicts WHERE id = ?`).get(conflictId) as
      | ConflictRow
      | undefined;
    return row ? this.hydrateConflict(row) : null;
  }

  /**
   * Resolve a conflict either by keeping one of its two claims (`keepClaimId`
   * must be the prior or new claim id from that conflict) or by recording a
   * new superseding claim via `mergeText` (inserted directly, bypassing
   * conflict detection, since it is the human/agent's authoritative
   * resolution — not a fact to be re-checked against the very claims it is
   * resolving).
   */
  resolveConflict(
    conflictId: string,
    resolution: { keepClaimId: string } | { mergeText: string; agent?: string }
  ): ConflictWithClaims {
    const existing = this.getConflict(conflictId);
    if (!existing) {
      throw new ConflictNotFoundError(`No conflict with id ${conflictId}`);
    }
    if (existing.resolved) {
      throw new ResolveError(`Conflict ${conflictId} is already resolved`);
    }

    let resolvedClaimId: string;
    let resolutionNote: string;

    if ("keepClaimId" in resolution) {
      if (
        resolution.keepClaimId !== existing.priorClaimId &&
        resolution.keepClaimId !== existing.newClaimId
      ) {
        throw new ResolveError(
          `--keep must reference one of this conflict's claims (${existing.priorClaimId} or ${existing.newClaimId}), got ${resolution.keepClaimId}`
        );
      }
      resolvedClaimId = resolution.keepClaimId;
      resolutionNote = `kept claim ${resolvedClaimId}`;
    } else {
      if (!resolution.mergeText || !resolution.mergeText.trim()) {
        throw new ResolveError("--merge text must be a non-empty string");
      }
      const mergeClaim = this.insertClaimDirect({
        subject: existing.subject,
        value: resolution.mergeText,
        file: null,
        confidence: 1,
        agent: resolution.agent ?? "resolver",
      });
      resolvedClaimId = mergeClaim.id;
      resolutionNote = `merged: ${resolution.mergeText}`;
    }

    const resolvedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conflicts SET resolved = 1, resolved_at = ?, resolved_claim_id = ?, resolution_note = ? WHERE id = ?`
      )
      .run(resolvedAt, resolvedClaimId, resolutionNote, conflictId);

    const updated = this.getConflict(conflictId);
    if (!updated) {
      throw new ConflictNotFoundError(`Conflict ${conflictId} vanished after update`);
    }
    return updated;
  }

  /** Insert a claim without running conflict detection (used for merge resolutions). */
  private insertClaimDirect(input: Required<Omit<RecordClaimInput, "file">> & { file: string | null }): Claim {
    const claim: Claim = {
      id: randomUUID(),
      subject: input.subject,
      value: input.value,
      normalizedValue: normalizeValue(input.value),
      file: input.file,
      confidence: input.confidence,
      agent: input.agent,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO claims (id, subject, value, normalized_value, file, confidence, agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        claim.id,
        claim.subject,
        claim.value,
        claim.normalizedValue,
        claim.file,
        claim.confidence,
        claim.agent,
        claim.createdAt
      );
    return claim;
  }
}
