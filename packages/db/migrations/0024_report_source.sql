-- Whether a report came from a person or from the platform's own screening (§61, §58.4).
--
-- `reporter_principal_id IS NULL` already carried two different facts and could not tell them
-- apart. §61.2 keeps reporting anonymous, so a stranger with no account files a report with no
-- principal; §58.2 item 6 has screening raise a report when it flags an article, and that one
-- also has no principal — "recording one would put a person's name on a machine's judgement".
--
-- The two are not interchangeable to a moderator. An anonymous report is somebody saying they
-- saw something; a screening report is the platform saying its own reader scored the article
-- and wants a person to look. They deserve different weight, different follow-up, and — since
-- the queue began naming reporters — different words on the line. Without this column that
-- line calls a machine's flag "from anonymous", which is false.
ALTER TABLE reports ADD COLUMN source TEXT NOT NULL DEFAULT 'human'
  CHECK (source IN ('human', 'automatic'));

-- Rows written before this column existed.
--
-- The default is right for every human report and wrong for any screening one, so the
-- automatic rows are recovered from the shape screening writes: no principal, no contact, and
-- a `details` line that opens with the provider's name and its score. It is a narrow match
-- rather than a clever one — a human report reaching that pattern would have to be anonymous,
-- contactless, and phrased like a provider — and the cost of a miss either way is a label on a
-- historical report, not a decision.
UPDATE reports
   SET source = 'automatic'
 WHERE reporter_principal_id IS NULL
   AND reporter_contact IS NULL
   AND details LIKE 'orator-%scored%';
