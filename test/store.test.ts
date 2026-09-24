import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BlackboardStore, ResolveError, ConflictNotFoundError } from "../src/store.js";

describe("BlackboardStore", () => {
  let store: BlackboardStore;

  beforeEach(() => {
    // In-memory SQLite DB per test: real node:sqlite engine, zero disk I/O,
    // fully isolated between tests.
    store = new BlackboardStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("records a claim and reads it back via listClaims", () => {
    const { claim, conflict } = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
      confidence: 0.9,
      file: "src/routes/login.ts",
    });

    expect(conflict).toBeNull();
    expect(claim.id).toBeTruthy();

    const claims = store.listClaims("auth.login.email-validation");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.id).toBe(claim.id);
    expect(claims[0]?.value).toBe(
      "the /login endpoint validates email format server-side"
    );
    expect(claims[0]?.agent).toBe("agent-a");
    expect(claims[0]?.file).toBe("src/routes/login.ts");
    expect(claims[0]?.confidence).toBe(0.9);

    const fetched = store.getClaim(claim.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.value).toBe(claim.value);
  });

  it("does NOT flag a conflict when a second identical claim is recorded for the same subject", () => {
    store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
    });

    // Same meaning, different casing/whitespace -> normalization should still
    // treat this as identical.
    const second = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "  THE /login endpoint validates   email format server-side  ",
      agent: "agent-b",
    });

    expect(second.conflict).toBeNull();
    expect(store.listClaims("auth.login.email-validation")).toHaveLength(2);
    expect(store.listConflicts()).toHaveLength(0);
  });

  it("does NOT flag a conflict between claims about clearly different subjects", () => {
    store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
    });
    const other = store.recordClaim({
      subject: "billing.invoice.currency-rounding",
      value: "invoice totals are rounded using banker's rounding",
      agent: "agent-b",
    });

    expect(other.conflict).toBeNull();
    expect(store.listConflicts()).toHaveLength(0);
  });

  it("flags a real conflict when a genuinely different claim is recorded for the same subject", () => {
    const first = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
      confidence: 0.9,
    });

    const second = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "email format validation only happens client-side in the login form",
      agent: "agent-b",
      confidence: 0.6,
    });

    expect(second.conflict).not.toBeNull();
    expect(second.conflict?.subject).toBe("auth.login.email-validation");
    expect(second.conflict?.priorClaimId).toBe(first.claim.id);
    expect(second.conflict?.newClaimId).toBe(second.claim.id);
    expect(second.conflict?.priorClaim.value).toBe(first.claim.value);
    expect(second.conflict?.newClaim.value).toBe(second.claim.value);
    expect(second.conflict?.resolved).toBe(false);
  });

  it("lists the conflict via listConflicts and clears it via resolve --keep", () => {
    const first = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
    });
    const second = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "email format validation only happens client-side in the login form",
      agent: "agent-b",
    });
    expect(second.conflict).not.toBeNull();
    const conflictId = second.conflict!.id;

    const unresolved = store.listConflicts();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.id).toBe(conflictId);

    const resolved = store.resolveConflict(conflictId, { keepClaimId: first.claim.id });
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedClaimId).toBe(first.claim.id);

    // Cleared from the default (unresolved-only) listing.
    expect(store.listConflicts()).toHaveLength(0);
    // Still visible in the full history if asked for.
    expect(store.listConflicts({ includeResolved: true })).toHaveLength(1);
  });

  it("clears a conflict via resolve --merge and records the merged claim", () => {
    store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
    });
    const second = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "email format validation only happens client-side in the login form",
      agent: "agent-b",
    });
    const conflictId = second.conflict!.id;

    const resolved = store.resolveConflict(conflictId, {
      mergeText: "server-side validation was removed; only client-side validation remains now",
      agent: "resolver-agent",
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.resolutionNote).toMatch(/^merged:/);
    expect(store.listConflicts()).toHaveLength(0);

    const claims = store.listClaims("auth.login.email-validation");
    expect(claims).toHaveLength(3);
    const mergeClaim = claims[claims.length - 1];
    expect(mergeClaim?.value).toBe(
      "server-side validation was removed; only client-side validation remains now"
    );
    expect(mergeClaim?.agent).toBe("resolver-agent");
    expect(resolved.resolvedClaimId).toBe(mergeClaim?.id);
  });

  it("rejects --keep with a claim id that does not belong to the conflict", () => {
    const unrelated = store.recordClaim({
      subject: "some.other.subject",
      value: "unrelated claim",
      agent: "agent-x",
    });
    store.recordClaim({
      subject: "auth.login.email-validation",
      value: "the /login endpoint validates email format server-side",
      agent: "agent-a",
    });
    const second = store.recordClaim({
      subject: "auth.login.email-validation",
      value: "email format validation only happens client-side in the login form",
      agent: "agent-b",
    });
    const conflictId = second.conflict!.id;

    expect(() =>
      store.resolveConflict(conflictId, { keepClaimId: unrelated.claim.id })
    ).toThrow(ResolveError);
  });

  it("throws ConflictNotFoundError for an unknown conflict id", () => {
    expect(() =>
      store.resolveConflict("does-not-exist", { keepClaimId: "also-does-not-exist" })
    ).toThrow(ConflictNotFoundError);
  });

  it("returns an empty claim history for a subject with no claims", () => {
    expect(store.listClaims("never.mentioned")).toEqual([]);
  });
});
