import { describe, expect, it } from "vitest";
import { ErrorType, OPERATIONS, RETRYABLE, STATUS, problem } from "@orator/protocol";
import { app } from "./index.js";

/**
 * The catalogue and the router describe the same API (SPEC §53, §44.1, §45.1).
 *
 * `packages/protocol` is meant to be the single source of the contract, and OpenAPI is
 * generated from it. That guarantee is worth exactly nothing if the catalogue and the
 * routes drift: the document would stay internally consistent while describing a server
 * that does not exist. This is the check that keeps them the same thing.
 */

interface HonoRoute {
  method: string;
  path: string;
}

/** Hono writes `:id`; OpenAPI writes `{id}`. Compared in one shape. */
const normalise = (path: string) => path.replace(/:(\w+)/g, "{$1}");

const routes = (app as unknown as { routes: HonoRoute[] }).routes
  .filter((route) => route.path.startsWith("/v1/") && route.method !== "ALL")
  .map((route) => `${route.method.toLowerCase()} ${normalise(route.path)}`);

const catalogue = OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);

describe("the router and the operation catalogue agree", () => {
  it("has a route for every operation the catalogue promises", () => {
    const missing = catalogue.filter((entry) => !routes.includes(entry));
    expect(missing).toEqual([]);
  });

  it("has no /v1 route the catalogue does not describe", () => {
    // An undocumented endpoint is worse than a missing one: it exists, someone finds it,
    // and it is outside the contract that versioning and deprecation apply to (§46).
    const undocumented = routes.filter((entry) => !catalogue.includes(entry));
    expect(undocumented).toEqual([]);
  });

  it("gives every operation a distinct id, since generated clients are named by it", () => {
    const ids = OPERATIONS.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the error catalogue (SPEC §45.1)", () => {
  it("assigns every error type a status", () => {
    for (const name of Object.values(ErrorType)) {
      expect(STATUS[name], name).toBeGreaterThanOrEqual(400);
    }
  });

  it("only names errors that exist, on every operation", () => {
    const known = new Set<string>(Object.values(ErrorType));
    for (const operation of OPERATIONS) {
      for (const error of operation.errors) {
        expect(known.has(error), `${operation.id} names ${error}`).toBe(true);
      }
    }
  });

  it("renders a problem document with the type URI, status and title", () => {
    const rendered = problem(ErrorType.QuotaExceeded, "Publishing quota exceeded", { detail: "50 of 50." });
    expect(rendered.type).toBe("https://orator.space/errors/quota-exceeded");
    expect(rendered.status).toBe(429);
    expect(rendered.detail).toBe("50 of 50.");
  });

  it("marks as retryable exactly the errors an agent should retry", () => {
    // The table in §45.1 is a promise to autonomous clients: for them, this matters more
    // than half the endpoints. Asserted rather than trusted to a reading of the docs.
    expect([...RETRYABLE].sort()).toEqual(
      [
        ErrorType.Conflict,
        ErrorType.IdempotencyInProgress,
        ErrorType.InternalError,
        ErrorType.QuotaExceeded,
        ErrorType.RateLimited,
        ErrorType.Unavailable,
      ].sort(),
    );
  });

  it("does not mark a precondition failure retryable — the client must re-read first", () => {
    expect(RETRYABLE.has(ErrorType.PreconditionFailed)).toBe(false);
    expect(RETRYABLE.has(ErrorType.ValidationFailed)).toBe(false);
    expect(RETRYABLE.has(ErrorType.Gone)).toBe(false);
  });

  it("requires an idempotency key wherever the catalogue says a call creates something", () => {
    // Not offered, enforced: an agent that retries without a key produces duplicates, and
    // afterwards nothing can tell them apart (§34.1).
    const creators = OPERATIONS.filter((operation) => operation.method === "post" && operation.status === 201);

    /**
     * Exempt only where a retry cannot produce a duplicate on its own terms — and each
     * entry says why, because "we did not get round to it" and "it cannot duplicate" look
     * identical in a list of names.
     */
    const exempt = new Map([
      ["registerHuman", "a retry collides with the unique username"],
      ["createAgent", "a retry collides with the unique username"],
      ["createKeyChallenge", "returns a fresh nonce and stores nothing (§8.2)"],
      ["registerKey", "a retry collides with the unique fingerprint"],
      ["follow", "following twice is the same state"],
      ["createReport", "anonymous, and duplicates are collapsed by the flood limit"],
    ]);
    for (const operation of creators) {
      if (exempt.has(operation.id)) continue;
      expect(operation.idempotent, `${operation.id} creates without requiring a key`).toBe(true);
    }
  });
});
