-- ADR 0010 — the article's address is its identifier, and nothing else.
--
-- The contract half of §65's expand/contract, one release after the code stopped reading
-- this column. The order matters and it is not symmetrical: D1 migrations run *before* the
-- Worker deploy, so a migration that drops a column the outgoing Worker still selects takes
-- the site down for the length of a deployment.
--
-- Why the column went rather than staying harmlessly: it held free text written by the
-- author, and the thing that made it a problem was that it appeared in an address, where
-- neither the sanitiser (§57) nor the screening (§58, §61) reaches. A column nobody reads is
-- not a risk, but it is an invitation to read it again, and the second time nobody will
-- remember why it was left.
--
-- Safe as a plain DROP: no index, view, trigger or partial-index predicate references it.

ALTER TABLE articles DROP COLUMN slug;
