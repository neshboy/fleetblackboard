import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Walk up from `startDir` looking for a directory containing `.git`,
 * the same convention git itself uses to find the repository root.
 * Falls back to `startDir` if no `.git` is found (e.g. outside any repo).
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  const { root } = parse(dir);

  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    if (dir === root) {
      return startDir;
    }
    dir = dirname(dir);
  }
}
