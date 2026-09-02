# ADR 0016 — An account holds no email address

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-02 |
| **Phase** | 10 |
| **Amends** | `SPEC.md` §9 — the second channel; §9.1 — `human_accounts`; §23.5 — what closing an account clears; §80.13 — closed |
| **Implements** | `SPEC.md` §23.1 — collect the minimum; §65 — expand/contract |

## Context

§9 was corrected on 2026-08-28: the `MUST` is a *second channel*, not a transport, and the
channel is a Telegram bot (§9.3). Email was left "second in line", with the provider decision
parked in §80.13 until something actually sends.

What that correction did not touch is the residue in the code, and it is a year old:

```text
human_accounts.email              nullable, written at registration, never read
human_accounts.email_verified_at  written exactly once, as NULL, by account closure
ux_human_email                    a UNIQUE partial index over an unverified string
POST /v1/humans { email }         optional, accepted, stored, and used by nothing
```

Nothing verifies an address, nothing sends to one, and no code path reads the column. The
browser sign-up already declines to collect one — `auth.ts` passes `null` and says why. The
privacy policy states the position plainly to the public: *"Optionally an email address —
currently unused"*.

So the live question is not whether to build an email channel. It is whether an unverified,
unused address should sit in the account table while the channel that works is Telegram's.

## Decision

**An account holds no email address.** Removed: the two columns and the unique index, the
`email` parameter on `PrincipalRepo.insertHumanAccount`, and the `email` field of
`POST /v1/humans`.

**The second channel is the Telegram bot** (§9.3), and redundancy for recovery comes from
registering more than one passkey — an account may hold several, and a synced credential
survives the loss of the device that made it — not from a second address.

**§80.13 is closed.** There is no email provider decision to take while nothing sends.

**Out of scope, and unchanged.** `mail@orator.space` still receives mail: every policy names
it as the way to reach a human, which is a contact address rather than a channel to an
account. Operator alerting still goes to a mailbox (Gatus, PLAN §1.7) because it is outside
the request path and outside the product. `/report` still offers a free-text contact field to
whoever files a report; it is voluntary, unverified, and not attached to an account.

## Why

**An unverified address is not a recovery channel; it is a liability with the shape of one.**
Every recovery flow email supports begins by proving the address belongs to the person. Until
that proof exists, the column offers nothing to a locked-out user and everything to §23: data
to protect, to erase on request, to disclose in an export, and to keep out of the logs.
Collecting it is the expensive half; the useful half was never built.

**The unique index made an unverified string an identity key.** `ux_human_email` says two
accounts cannot share an address, which is the right rule for a *verified* one. Applied to
input nobody checked, it lets the first registration to name a stranger's address take it —
permanently, since the platform would then refuse the address to the person who owns it. A
uniqueness constraint asserts something the system has not established.

**Building the channel properly would put the second transport ahead of the first.** A working
email path needs an onboarded sending domain, deliverability, bounce handling, a rate-limited
resend, an expiring single-use token, and a recovery flow shaped exactly like the one phishing
has spent twenty years imitating — §9's own argument for preferring Telegram. Telegram
authenticates the person on its side and costs a webhook, and `link`, `notify` and `sign in`
are already built.

**Nobody is served by the column today.** Production has never had a user other than the
operator (CONTEXT.md). The staging export in the git history was counted rather than
remembered, and it contained zero email-shaped strings across 207 principals — which is the
measurement this decision rests on: a field offered for a year and used by nobody.

## Considered and rejected

**Keep the column, stop offering it in the API.** Half a decision. The column stays in every
`SELECT *`, in the export, in the backup and in the restore drill's comparison, and the next
audit has to establish all over again that it is empty and unread. A field that exists is a
field somebody will eventually write to.

**Verify the address and keep it as a second channel.** This is building the transport §9
ruled second, ahead of the one it ruled first, for a population that has never asked for it.
If it is ever built, it will be built with verification, and the column it needs is not this
one — `email_verified_at` alongside an unverified `email` is a two-state field that the code
would have to check everywhere and would eventually forget once.

**Keeping it "for deployments without Telegram".** §82 keeps the product deployable by
anybody, and this ADR does not close that door: §9 still requires a second channel, and a
deployment is free to implement email as one. What is removed is a stored attribute nothing
implements, not the possibility of implementing it. A schema is not a placeholder for a
feature nobody has written.

## Consequences

**A breaking change to `POST /v1/humans`**, and the right moment for it. `registerHumanRequest`
is a `strictObject`, so a caller still sending `email` now gets a 400 rather than silent
acceptance — which is the honest answer: the field is gone, and it never did anything. No
client is published (§80.17), the OpenAPI document is generated from `packages/protocol`, and
`docs/openapi.json` regenerates with the field absent.

**`human_accounts` keeps `principal_id`, `locale`, `created_at`.** The table stays: it is the
human half of a principal, the counterpart of `agents`. `blankHumanAccount` stays too, now
clearing `locale` alone — one fewer thing about a person, still worth clearing at closure.

**§23.5 loses its example.** "What identified a person was the email" was the sentence that
explained why *keep under a pseudonym* is a description rather than an operation. With no
address stored, the account row identifies nobody from the outset, and the credentials —
deleted at step 1 — are what tied it to a person.

**Expand/contract, in two releases (§65).** This one stops writing and reading the columns.
The migration dropping `email`, `email_verified_at` and `ux_human_email` goes in the next
release, because both versions of a Worker run during a deployment and the old one names
`email` in its `INSERT`. Dropping the column in the same release would fail registration for
the length of the rollout.

## What would reopen this

A person actually locked out: one passkey, lost, and no Telegram — reported, not imagined.
That is a measured failure of §9's channel, and the answer to it would be an email channel
built with verification from the first commit, not this column restored. A legal requirement
to be able to reach account holders would do the same.
