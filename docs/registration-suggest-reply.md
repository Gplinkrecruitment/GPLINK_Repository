# Grounded Suggest-a-Reply

## What it does
The "✦ Suggest a reply" button drafts a reply the RSO reviews and sends (never auto-sent). The AI is given: a small **stage-scoped playbook** (standard guidance for the doctor's current stage), the candidate's **real facts** (stage, open tasks, document/qualification status), the **recent emails**, and a **background summary** reused from the 24h candidate summary. It is instructed to use only those facts and to flag `[RSO: please confirm …]` when unsure.

## Owning the playbook
The per-stage guidance lives in `lib/registration-playbook.js` (`STAGE_PLAYBOOK`). It is plain text — review and refine it as the registration process changes. Keep each stage section tight (under ~1200 chars) so it stays cheap to send.

## Cost / model
- Model: `SUGGEST_REPLY_MODEL` env (default `claude-opus-4-6`). For lower cost you can set it to `claude-sonnet-4-6` or `claude-haiku-4-5` and compare quality.
- The static block (rules + playbook) is prompt-cached, so repeated suggestions within a few minutes are ~90% cheaper on that portion. Because the playbook is small, each suggestion is roughly a cent regardless of cache state.
- It only runs when the RSO clicks Suggest — never automatically.

## Grounding guardrails (why RSOs can trust it)
- Draft-only — it fills the reply box; nothing is auto-sent.
- Uses only the supplied facts; flags `[RSO: please confirm …]` when unsure; never claims a step is complete unless the facts say so.
- **Practice-document guardrail:** the facts include `practice_documents.{outstanding_from_practice, do_not_request}`, and the grounding rules forbid the AI from asking a practice for anything in `do_not_request` (already received / automatic / under review / waiting on the GP / not yet formally requested). This stops premature SPPA-00 / Section G / Supervisor CV requests.

## Known follow-ups
- **Signer name:** the draft signs as "Hazel" regardless of the case's assigned RSO. Outbound mail already sends from the assigned RSO's mailbox, so parameterise the signer name to the assigned RSO (pass it into `buildSuggestReplyMessages`).
- **Practice signing specifics:** the `career` playbook section could note the exact signing requirements (Supervisor CV dated+signed by the supervisor; Position Description signed by the owner; Offer/Contract signed by both) — domain content for the owner to add.
- The playbook currently covers myintealth/amc/career(placement)/ahpra/pbs/commencement. Visa is aliased to the AHPRA section (visa is deferred in v1).
