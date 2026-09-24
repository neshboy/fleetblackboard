import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot } from "../src/repo-root.js";

describe("findRepoRoot", () => {
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const dir of dirsToClean.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("walks up from a nested directory to find the directory containing .git", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-repo-"));
    dirsToClean.push(root);
    mkdirSync(join(root, ".git"));
    const nested = join(root, "src", "deeply", "nested");
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it("falls back to the starting directory when no .git is found", () => {
    const noGitDir = mkdtempSync(join(tmpdir(), "bb-nogit-"));
    dirsToClean.push(noGitDir);
    // tmpdir() itself is very unlikely to be inside a git repo; if it is,
    // this assertion would need adjustment, but that's not the case here.
    expect(findRepoRoot(noGitDir)).toBe(noGitDir);
  });
});
