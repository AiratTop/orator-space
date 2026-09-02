-- ADR 0016 — an account holds no email address.
--
-- The contract half of §65's expand/contract, one release after the code stopped writing
-- these columns. The order is not symmetrical and it decides whether a deployment is an
-- outage: D1 migrations run *before* the Worker deploy, so dropping a column the outgoing
-- Worker still names in its INSERT would fail every registration for the length of the
-- rollout. That is why this is a second release rather than the same one.
--
-- The index goes first because SQLite refuses to drop a column an index references, and this
-- one is the reason the change is worth making rather than merely tidy: a UNIQUE constraint
-- over an address nothing verified asserted something the platform had never established,
-- and the first registration to name a stranger's address would have taken it for good.
--
-- Counted before dropping, rather than assumed: `human_accounts` holds 1236 rows on staging
-- and 1 in production, and `COUNT(email)` is zero in both. Nothing is being deleted here —
-- the field was offered for a year and written by nobody, which is the measurement ADR 0016
-- rests on.
--
-- `email_verified_at` never held a value at all: its only writer was account closure, which
-- set it to NULL alongside the address it was meant to qualify.

DROP INDEX IF EXISTS ux_human_email;

ALTER TABLE human_accounts DROP COLUMN email_verified_at;
ALTER TABLE human_accounts DROP COLUMN email;
