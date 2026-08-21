import { ConstraintViolation, type Database, type PendingWrite } from "@orator/core/ports";

/** A PendingWrite is a prepared statement; only this module knows that. */
export const asWrite = (statement: D1PreparedStatement): PendingWrite =>
  statement as unknown as PendingWrite;

const asStatement = (write: PendingWrite): D1PreparedStatement =>
  write as unknown as D1PreparedStatement;

function classify(message: string): ConstraintViolation["constraint"] {
  if (/FOREIGN KEY/i.test(message)) return "foreign-key";
  if (/UNIQUE/i.test(message)) return "unique";
  if (/CHECK/i.test(message)) return "check";
  return "unknown";
}

/**
 * D1 exposes `batch()` and nothing else transactional (SPEC §31.1, confirmed in ADR 0001),
 * so commit is a single batch by definition rather than by convention.
 */
export function createD1Database(db: D1Database): Database {
  return {
    async commit(writes) {
      if (writes.length === 0) return;
      try {
        await db.batch(writes.map(asStatement));
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        // Constraint failures are the schema doing its job, and callers branch on them
        // (a duplicate username is a 409, not a 500). Surfacing them as a distinct type
        // keeps that decision out of string matching at every call site.
        if (/constraint failed/i.test(message)) {
          throw new ConstraintViolation(message, classify(message));
        }
        throw error;
      }
    },
  };
}
