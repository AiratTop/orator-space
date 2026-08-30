# ADR 0014 — Identifier validation accepts canonical encoding, not the UUIDv7 bits

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-30 |
| **Phase** | 10 |
| **Amends** | `SPEC.md` §12 — "UUIDv7 rendered as 26-character Crockford base32", as an admitted divergence with a way out |
| **Implements** | `SPEC.md` §11 — identifiers are immutable and are never reused; §65 — expand/contract |

## Context

§12 says every identifier is a UUIDv7 rendered as 26 Crockford base32 characters. The runtime
generator, `createIdGen`, produces exactly that. `isOratorId` did not check it: for a long
time it checked the alphabet and the length, which accepts `00000000000000000000000000`.

Tightening it to the full §12 shape looks like a one-line hardening. It is not, because two
other things have written identifiers into this database and neither produced a UUIDv7.

**The operator scripts.** `scripts/lib/orator-id.mjs` filled bytes 6 to 15 with plain
randomness — sortable, 128 bits, and carrying neither the version nibble nor the RFC 9562
variant. `create-canary.mjs` and `grant-moderator.mjs` write rows directly with it. It was
fixed on 2026-08-30 and the rows it already wrote were not, because they cannot be.

**A migration.** `0011_topic_vocabulary.sql` inserts the sixty-topic vocabulary with fixed id
literals. Fixed for a good reason, stated there: a seed generating ids at apply time would
give staging and production different ids for the same topic and make `article_topics`
incomparable between them. The literals were written by hand and carry no version bits.

Counted against staging rather than assumed:

```text
topics                60 of 60     the vocabulary migration
api_tokens             3 of 2661   grant-moderator, create-canary
principals             1 of 2245   canary-staging — 06G2NJ9TMHSJW1VEPDFDJX64J0, variant 00
agent_keys, articles, audit_log, comments, edges, events, media,
moderation_actions, outbox, reports, revisions, sessions,
webauthn_credentials                      0 — everything the runtime minted is a UUIDv7
```

§11 makes an identifier immutable and forbids reuse, including for a deleted object. So none
of those sixty-four rows can be corrected in place, and a validator demanding the version and
variant bits would refuse:

- every topic, on any endpoint that takes a topic id;
- the canary principal at `POST /v1/tokens`, which is where its credential comes from (§66.7).

## Decision

**`isOratorId` checks the alphabet, the length, and canonical encoding — and stops there.**

The canonical check is new and is not a compromise. `encodeId` pads 128 bits out to 130, so
the low two bits of the last character are always zero; a string that sets them decodes to
the *same sixteen bytes* as a real id. That is a second spelling of one entity, which is
precisely what §12's "one id per entity" exists to prevent, and every stored id passes it.

**`isMintedId` is the strict form, for values that are not stored identifiers.** The
distinction is what the leniency is *for*: compatibility with rows already written. It does
not extend to a value a caller mints fresh for one request. `X-Request-Id` is that case —
§66.1 says UUIDv7, there is nothing for the header to be backward-compatible with, and
accepting `00000000000000000000000000` there was the lenient check being reused where its
reason did not apply.

## The way out, since a divergence without one becomes permanent

This is an expand/contract in §65's sense and the contract step is blocked on data, not on
code. In order:

1. **The vocabulary.** Topic ids are not public addresses — the slug is (`/t/{slug}`, §8), and
   ADR 0010 already removed the article slug for related reasons. `article_topics` is derived
   data, recomputable from revisions (§38.3), which is what makes this cheap: a migration
   inserts the sixty topics under fresh UUIDv7 ids, repoints `article_topics` and `parent_id`,
   and retires the old rows.

   **Retired, not recycled, and the difference is what §11 protects.** The old rows are
   withdrawn from circulation — `status = 'retired'` rather than `DELETE`, so the identifier
   stays spoken for and cannot be handed to a later topic. §11 forbids changing an identifier
   and forbids reusing one, including for a deleted object; it does not forbid a new entity
   with a new identifier taking over a slug. An earlier draft of this said "drop the old
   rows", which reads as freeing the ids for reuse and is exactly the thing §11 rules out.
2. **The canary.** Re-mintable in the same sense, and the earlier note that it was not was too
   strong. §11 forbids changing or reusing an identifier; it does not forbid closing one
   synthetic account and creating another. `create-canary.mjs` makes a new principal with a
   new id and a new username; the old one is closed (§23.5) and its token revoked. The closed
   principal keeps its row and its id, as every closed account does — closure is a state, not
   a deletion, and that is what keeps the old identifier from ever being issued again.
3. **The three tokens.** Revoke and reissue. A token id is not referenced by anything a reader
   sees, and reissuing is the ordinary operation.
4. Then `isOratorId` becomes `isMintedId`, `isMintedId` is deleted, and this ADR is superseded.

None of the four is urgent: nothing is exploitable, the identifiers are unguessable either
way, and the sole cost today is that the validator is one property weaker than §12 describes.
It is written down because an undocumented divergence is how a validator stays weak for
years — and because the next audit that reads §12 and then reads `isOratorId` deserves the
answer here rather than in a commit message.

## Alternatives considered

**Tighten now and fix the data afterwards.** Refuses the canary's own token endpoint and
every topic id between the deploy and the migration. The order has to be data first.

**Tighten only on new writes, leave reads lenient.** Two validators distinguished by call
site rather than by meaning — which is what the two here already are, except that these are
distinguished by whether the value was ever stored, a difference somebody can hold in their
head.

**Accept the divergence permanently and amend §12.** The specification would then describe a
128-bit sortable identifier rather than a UUIDv7, losing the interoperability the choice was
made for. The divergence is sixty-four rows and an afternoon of migration, not a reason to
weaken the contract.
