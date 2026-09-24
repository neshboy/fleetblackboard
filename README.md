# Fleet Knowledge Blackboard (`blackboard`)

A shared, conflict-aware fact store for a fleet of parallel coding agents working the same repository.

## Why

When you run several coding agents against the same codebase at once, each one independently builds up beliefs about how the code works — "the `/login` endpoint validates email server-side", "this cache is invalidated on write", "config is loaded from `.env` only in dev". Nothing today stops two agents from silently forming **contradictory** beliefs about the same thing. Agent A ships a fix assuming server-side validation exists; Agent B ships a fix assuming it doesn't. Nobody notices until it breaks in a way that's hard to trace back to two agents that never talked to each other.

Fleet Knowledge Blackboard gives agents a place to record what they believe, tagged by a short **subject key** ("what this claim is about"), and it deterministically — no LLM, no guessing — flags the moment two claims about the *same* subject key state *different* things. It's a correctness backstop, not a truth oracle: it tells you "these two claims disagree," and leaves resolving which one is right to a human or another agent pass.

## Install / quick start

```bash
npm install
npm run build
npm link      # makes the `blackboard` command available locally
```

Run it from inside any git repository. It stores its database at `.blackboard/store.db`, found by walking up from your current directory to the nearest ancestor containing a `.git` folder — the same convention `git` itself uses to find the repo root.

### Example: two agents silently disagree

Agent A records what it found while working on the login flow:

```bash
blackboard record "auth.login.email-validation" \
  "the /login endpoint validates email format server-side" \
  --agent "agent-a-session-17" --confidence 0.9 --file src/routes/login.ts
```

```
Recorded claim 250f84a1-ed16-4717-a905-68cd275fc880 for subject "auth.login.email-validation".
```

Later, Agent C works on the same area and comes to a different conclusion:

```bash
blackboard record "auth.login.email-validation" \
  "email format validation only happens client-side in the login form" \
  --agent "agent-c-session-22" --confidence 0.6
```

```
Recorded claim d09a5c9c-2c7d-4d01-85c4-37910b12df02 for subject "auth.login.email-validation".

!! CONFLICT DETECTED with the most recent prior claim for this subject !!
CONFLICT 86343cb4-fdcc-44ad-99c8-731ae8e1a103  subject="auth.login.email-validation"  UNRESOLVED
  --- prior claim ---
  claim   edf9db61-7eb2-4ef5-ba01-2b029da3dc86
  value   the /login endpoint validates email format server-side
  ...
  --- new claim ---
  claim   d09a5c9c-2c7d-4d01-85c4-37910b12df02
  value   email format validation only happens client-side in the login form
  ...

Resolve with: blackboard resolve 86343cb4-fdcc-44ad-99c8-731ae8e1a103 --keep <claim-id>
         or:  blackboard resolve 86343cb4-fdcc-44ad-99c8-731ae8e1a103 --merge "<merged text>"
```

The command exits non-zero when it detects a conflict, so it's easy to check for in a script or agent harness.

Anyone (human or another agent) can now inspect the full history and resolve it:

```bash
blackboard claims "auth.login.email-validation"
blackboard conflicts
blackboard resolve 86343cb4-fdcc-44ad-99c8-731ae8e1a103 \
  --merge "server-side validation was removed in a recent refactor; only client-side validation remains as of 2026-09"
```

`--merge` records a brand new claim that supersedes both sides of the conflict and marks the conflict resolved. Alternatively, `--keep <claim-id>` picks whichever of the two existing claims was actually correct, without inventing new text.

## CLI reference

```
blackboard record <subject> "<value>" [--file <path>] [--confidence 0.0-1.0] [--agent "<label>"]
blackboard claims <subject>
blackboard conflicts [--all]
blackboard resolve <conflict-id> --keep <claim-id>
blackboard resolve <conflict-id> --merge "<new text>" [--agent "<label>"]
blackboard --db <path> <command> ...   # override the default .blackboard/store.db location
```

- `record` — record a claim about the codebase under a subject key. If the subject already has a prior claim whose *normalized* value differs from this one, a conflict is created and reported immediately, and the process exits with status 1.
- `claims <subject>` — full chronological history of every claim recorded under that subject key, oldest first. Useful for seeing how understanding evolved, or exactly where it diverged.
- `conflicts` — lists all currently unresolved conflicts across the whole store (pass `--all` to include resolved ones too).
- `resolve` — marks a conflict resolved, either by keeping one of its two claims (`--keep`) or by recording a new superseding claim (`--merge`).

## How conflict detection actually works

This is the mechanical, testable core of the tool (see `src/store.ts` and `test/store.test.ts`):

1. Every claim's `value` is normalized: trimmed, lowercased, internal whitespace collapsed to single spaces.
2. When a new claim is recorded for a subject that already has at least one prior claim, the new claim's normalized value is compared against the **most recently recorded** prior claim's normalized value for that same subject.
3. If they're identical after normalization → no conflict (this also means "THE /login endpoint validates   email format server-side" and "the /login endpoint validates email format server-side" are correctly treated as the same claim).
4. If they differ at all → a `Conflict` row is created referencing both claim ids, and both claims are shown side by side.
5. Claims about different subject keys never conflict with each other, by construction — conflict detection is always scoped to a single subject.

## Storage

The store is a real, file-based SQLite database, using Node's built-in **`node:sqlite`** module (`DatabaseSync`) rather than an external native binding like `better-sqlite3`. This was a deliberate choice for this environment: `node:sqlite` ships inside Node itself (available unflagged on Node ≥ 22.5, developed and tested here on Node 24), so there is no native-module compilation step, no prebuilt-binary download, and no risk of `npm install` failing on a contributor's or CI machine due to a missing build toolchain. A flat JSON file was considered as a fallback per the project brief, but wasn't needed since `node:sqlite` installed and worked with zero friction. The schema (`src/store.ts`) has two tables, `claims` and `conflicts`, with plain SQL and prepared statements — no ORM.

By default the database lives at `<repo-root>/.blackboard/store.db`, where `<repo-root>` is found by walking up from the current directory looking for a `.git` folder (see `src/repo-root.ts`), matching git's own convention. `.blackboard/` is git-ignored by default in this repo's own `.gitignore` — you may want to `.gitignore` it in consuming repos too, or commit it if you want the claim history to travel with the repo; that choice is left to the consuming project.

## Limitations (read this before trusting it)

- **This is exact/near-exact string matching after normalization — not semantic understanding.** Two claims that say the *same thing* in very different words (e.g. "validated server-side" vs. "checked on the backend before it hits the database") will **not** be recognized as agreeing, and will be flagged as a conflict even though a human would say they agree. Conversely, this tool cannot tell you that two claims phrased similarly but meaning subtly different things are actually in conflict if their normalized text happens to match — it doesn't happen in practice since exact string matches are exact, but the point stands: there is no understanding of meaning here.
- Recognizing that two differently-worded claims are semantically equivalent (or that two similar-sounding claims subtly disagree) would require an LLM or embedding-based similarity check. That's deliberately out of scope for this deterministic v1 — this tool is meant to be a mechanical, 100%-reproducible backstop that never needs an API call or produces a different answer on a re-run, and adding semantic matching would trade that reliability for recall it can't be honest about.
- Conflict detection only compares a new claim against the single most recently recorded prior claim for that subject, not the full history. If a subject already has claims "A" and "B" on record (with "B" most recent) and a third claim "A" is recorded again, it will be flagged as conflicting with "B" — even though "A" was already said before — because "A" doesn't match the *latest* claim. Given the full history is always available via `blackboard claims <subject>`, this tradeoff keeps the detection rule simple and easy to reason about.
- Single-process, single-machine local storage (SQLite file). There's no network sync, merge, or multi-writer story for agents on different machines — it's built for the common case of several agent sessions sharing one working copy of a repo on one machine.
- No authentication/authorization; any process with filesystem access to `.blackboard/store.db` can read or write claims.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm test          # builds, then runs the full vitest suite (unit + CLI end-to-end)
npm run dev        # run the CLI from source via tsx, no build step
```

## License

MIT — see [LICENSE](./LICENSE).
