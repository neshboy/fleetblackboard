import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end smoke test that exercises the ACTUAL compiled CLI binary
// (dist/cli.js, built by `npm run build` / the `pretest` script) against a
// real throwaway git repo, proving the shipped command line interface works
// end to end and not just the underlying library.
describe("blackboard CLI (end-to-end)", () => {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  let repoDir: string;

  function run(args: string[]): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [cliPath, ...args], {
        cwd: repoDir,
        encoding: "utf8",
      });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "bb-cli-e2e-"));
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("builds the CLI before this test suite runs", () => {
    expect(existsSync(cliPath)).toBe(true);
  });

  it("records claims, detects a real conflict, lists it, and resolves it", () => {
    const first = run([
      "record",
      "auth.login.email-validation",
      "the /login endpoint validates email format server-side",
      "--agent",
      "agent-a",
      "--confidence",
      "0.9",
    ]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/Recorded claim/);
    expect(existsSync(join(repoDir, ".blackboard", "store.db"))).toBe(true);

    const identical = run([
      "record",
      "auth.login.email-validation",
      "THE /login endpoint validates email format server-side",
      "--agent",
      "agent-b",
    ]);
    expect(identical.status).toBe(0);
    expect(identical.stdout).not.toMatch(/CONFLICT/);

    const different = run([
      "record",
      "auth.login.email-validation",
      "email format validation only happens client-side in the login form",
      "--agent",
      "agent-c",
    ]);
    expect(different.status).toBe(1);
    expect(different.stdout).toMatch(/CONFLICT DETECTED/);

    const claims = run(["claims", "auth.login.email-validation"]);
    expect(claims.status).toBe(0);
    expect(claims.stdout).toMatch(/3 claim\(s\)/);

    const conflicts = run(["conflicts"]);
    expect(conflicts.status).toBe(0);
    expect(conflicts.stdout).toMatch(/1 conflict\(s\)/);
    const idMatch = conflicts.stdout.match(/CONFLICT ([a-f0-9-]{36})/);
    expect(idMatch).not.toBeNull();
    const conflictId = idMatch![1]!;

    const resolve = run([
      "resolve",
      conflictId,
      "--merge",
      "validation was moved client-side in a recent refactor",
    ]);
    expect(resolve.status).toBe(0);
    expect(resolve.stdout).toMatch(/Resolved conflict/);

    const conflictsAfter = run(["conflicts"]);
    expect(conflictsAfter.status).toBe(0);
    expect(conflictsAfter.stdout).toMatch(/No unresolved conflicts/);
  });
});
