#!/usr/bin/env node
import { Command } from "commander";
import { join } from "node:path";
import { BlackboardStore, ConflictNotFoundError, ResolveError } from "./store.js";
import { findRepoRoot } from "./repo-root.js";
import type { Claim, ConflictWithClaims } from "./types.js";

function defaultDbPath(): string {
  const repoRoot = findRepoRoot(process.cwd());
  return join(repoRoot, ".blackboard", "store.db");
}

function openStore(dbPathOverride?: string): BlackboardStore {
  const dbPath = dbPathOverride ?? defaultDbPath();
  return new BlackboardStore(dbPath);
}

function fmtClaim(claim: Claim): string {
  const lines = [
    `  claim   ${claim.id}`,
    `  subject ${claim.subject}`,
    `  value   ${claim.value}`,
    `  file    ${claim.file ?? "(none)"}`,
    `  conf.   ${claim.confidence}`,
    `  agent   ${claim.agent}`,
    `  when    ${claim.createdAt}`,
  ];
  return lines.join("\n");
}

function fmtConflict(conflict: ConflictWithClaims): string {
  const header = `CONFLICT ${conflict.id}  subject="${conflict.subject}"  ${
    conflict.resolved ? `resolved (${conflict.resolutionNote ?? ""})` : "UNRESOLVED"
  }`;
  const prior = `  --- prior claim ---\n${fmtClaim(conflict.priorClaim)}`;
  const next = `  --- new claim ---\n${fmtClaim(conflict.newClaim)}`;
  return [header, prior, next].join("\n");
}

const program = new Command();

program
  .name("blackboard")
  .description(
    "Fleet Knowledge Blackboard: a shared, conflict-aware fact store for parallel coding agents."
  )
  .option("--db <path>", "override the store.db path (defaults to <repo-root>/.blackboard/store.db)");

program
  .command("record")
  .description("Record a new claim about the codebase under a subject key")
  .argument("<subject>", 'short key identifying what the claim is about, e.g. "auth.login.email-validation"')
  .argument("<value>", "the actual claim text")
  .option("--file <path>", "optional file reference the claim pertains to")
  .option("--confidence <number>", "confidence 0-1 (default 0.8)", parseFloat)
  .option("--agent <label>", "recording agent's session id/label (default \"unknown\")")
  .action((subject: string, value: string, opts) => {
    const globalOpts = program.opts();
    const store = openStore(globalOpts.db);
    try {
      const { claim, conflict } = store.recordClaim({
        subject,
        value,
        file: opts.file ?? null,
        confidence: opts.confidence,
        agent: opts.agent,
      });
      console.log(`Recorded claim ${claim.id} for subject "${claim.subject}".`);
      if (conflict) {
        console.log("");
        console.log("!! CONFLICT DETECTED with the most recent prior claim for this subject !!");
        console.log(fmtConflict(conflict));
        console.log("");
        console.log(`Resolve with: blackboard resolve ${conflict.id} --keep <claim-id>`);
        console.log(`         or:  blackboard resolve ${conflict.id} --merge "<merged text>"`);
        process.exitCode = 1;
      }
    } finally {
      store.close();
    }
  });

program
  .command("claims")
  .description("Show the full claim history for a subject key")
  .argument("<subject>", "subject key")
  .action((subject: string) => {
    const globalOpts = program.opts();
    const store = openStore(globalOpts.db);
    try {
      const claims = store.listClaims(subject);
      if (claims.length === 0) {
        console.log(`No claims recorded for subject "${subject}".`);
        return;
      }
      console.log(`${claims.length} claim(s) for subject "${subject}" (oldest first):`);
      console.log("");
      claims.forEach((claim, i) => {
        console.log(`[${i + 1}]`);
        console.log(fmtClaim(claim));
        console.log("");
      });
    } finally {
      store.close();
    }
  });

program
  .command("conflicts")
  .description("List conflicts across the whole store")
  .option("--all", "include already-resolved conflicts")
  .action((opts) => {
    const globalOpts = program.opts();
    const store = openStore(globalOpts.db);
    try {
      const conflicts = store.listConflicts({ includeResolved: !!opts.all });
      if (conflicts.length === 0) {
        console.log(opts.all ? "No conflicts recorded." : "No unresolved conflicts.");
        return;
      }
      console.log(`${conflicts.length} conflict(s):`);
      console.log("");
      for (const conflict of conflicts) {
        console.log(fmtConflict(conflict));
        console.log("");
      }
    } finally {
      store.close();
    }
  });

program
  .command("resolve")
  .description("Resolve a conflict by keeping one claim or recording a merged claim")
  .argument("<conflictId>", "conflict id, as shown by `blackboard conflicts`")
  .option("--keep <claimId>", "id of the claim (prior or new) that should stand")
  .option("--merge <text>", "record a new superseding claim with this text")
  .option("--agent <label>", 'agent label to attribute the merge claim to (default "resolver")')
  .action((conflictId: string, opts) => {
    const globalOpts = program.opts();
    if (!opts.keep && !opts.merge) {
      console.error("Error: must pass either --keep <claim-id> or --merge \"<text>\"");
      process.exitCode = 2;
      return;
    }
    if (opts.keep && opts.merge) {
      console.error("Error: pass only one of --keep or --merge, not both");
      process.exitCode = 2;
      return;
    }
    const store = openStore(globalOpts.db);
    try {
      const resolution = opts.keep
        ? { keepClaimId: opts.keep as string }
        : { mergeText: opts.merge as string, agent: opts.agent as string | undefined };
      const updated = store.resolveConflict(conflictId, resolution);
      console.log(`Resolved conflict ${updated.id}: ${updated.resolutionNote}`);
    } catch (err) {
      if (err instanceof ConflictNotFoundError || err instanceof ResolveError) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    } finally {
      store.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
