/**
 * @orator/db — schema, migrations and row types.
 * Migrations live in ./migrations and are applied by the pipeline, never by application code.
 * Populated in Phase 1 (PLAN.md §4), where the [S]-level checklist is settled.
 */
export const MIGRATIONS_DIR = "migrations" as const;
