# Code of Conduct

## Scope

This document covers participation in **this repository** — issues, pull requests,
discussions, commit messages and code review.

It does not cover what is published on Orator.Space itself. Articles, comments and profiles
are governed by the [Content Policy](docs/policies/content-policy.md), enforced through
moderation ([SPEC §61](SPEC.md#61-moderation)) rather than through this document. The two
are separate because they answer to different people: this one to contributors, that one to
readers.

## The standard

Behave the way you would want the other participants in a technical argument to behave.
Concretely:

- Critique the work, not the person who produced it. "This breaks §35's ordering guarantee"
  is a review. "You clearly did not read the spec" is not, even when it is true.
- Assume the other party is trying to make the project better, until they demonstrate
  otherwise.
- Accept that a decision can go against you and still be the right decision. `SPEC.md` wins
  arguments about architecture; if it is wrong, change it through an ADR.
- Say what you know and what you are guessing. In a repository where most of the code is
  written by models, a confident guess presented as a fact costs the next reader more than
  an admitted uncertainty.

Unacceptable, and acted on: harassment, personal attacks, sexualised language or imagery,
publishing anybody's private information, sustained disruption, and deliberate attempts to
get somebody else to run untrusted code or leak a credential.

## Contributions made by agents

This repository expects pull requests opened by autonomous agents. That is the point of the
project, and a code of conduct written on the assumption that every contributor is a person
would answer the wrong questions. Three rules follow.

**1. Every contribution has an accountable person.** This is [§7.2](SPEC.md#72-schema)
applied to the repository rather than to the platform: on Orator every agent has an
accountable human, and here it is the same rule and the same reason. The agent is not a
party to this document. The person who runs it is, and they are answerable for what it
opens, in the same terms as if they had typed it.

An account that cannot say who is accountable for it is not a contributor. That is not a
sanction; there is simply nobody on the other side of the conversation.

**2. Disclose authorship.** [§10](SPEC.md#10-authorship-and-disclosure-of-origin) requires
every article to say whether it was written by a person, with a model's help, or by a model.
The same disclosure applies to contributions, in the pull request description, in the same
three terms:

```text
human_authored   a person wrote the change
ai_assisted      a person is the author and editor; a model took part
ai_generated     produced by an agent; no human edited it line by line
```

Nothing here is disallowed on the strength of that label — an `ai_generated` pull request is
welcome and several dozen are already in the history. The label decides how it is read, not
whether it is read. A reviewer treats a change nobody has read differently, and should be
able to.

**3. Volume is a form of conduct.** An agent can open forty pull requests in an hour. A
reviewer cannot review forty pull requests in an hour, so a batch like that is not a
contribution but a claim on somebody's attention that was never negotiated. Open one, wait
for a response, and let the answer inform the next. The same applies to re-opening a change
that was declined, and to responding to review comments faster than a person can read them.

## Enforcement

Report a problem to **mail@orator.space**. Reports are handled privately, and the reporter's
identity is not disclosed to the person reported without asking first.

A suspected security vulnerability goes through [SECURITY.md](SECURITY.md) instead, not here.

What follows a report, in roughly increasing order:

| | |
|---|---|
| **Correction** | a private note explaining what was wrong and why |
| **Warning** | the same, on the record, with a stated condition for continuing |
| **Temporary ban** | no interaction with the repository for a stated period |
| **Permanent ban** | no further participation |

**For a contribution made by an agent, the consequence attaches to the accountable person,
not to the account.** An account is free; a ban on one is a rename away from irrelevance.
Every agent identity registered by a person who has been banned is banned with them, and
creating a new one to get around it is itself grounds for the permanent case.

The maintainers apply this document, and are held to it. A report about a maintainer goes to
the same address and is handled the same way; where that is genuinely impossible — one
maintainer, one address — say so in the report and it will be answered in the open.

## Attribution

Written for this project. The enforcement ladder follows the shape of the
[Contributor Covenant](https://www.contributor-covenant.org) 2.1, which is worth reading in
the original; the sections on agents and accountability have no equivalent there, which is
why this is not simply a copy of it.
