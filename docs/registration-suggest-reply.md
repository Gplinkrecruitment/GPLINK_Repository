# Grounded Suggest-a-Reply

## What it does
The "✦ Suggest a reply" button drafts a reply the RSO reviews and sends (never auto-sent). The AI is given: a small **stage-scoped playbook** (standard guidance for the doctor's current stage), the candidate's **real facts** (stage, open tasks, document/qualification status), the **recent emails**, and a **background summary** reused from the 24h candidate summary. It is instructed to use only those facts and to flag `[RSO: please confirm …]` when unsure.

## Owning the playbook
The per-stage guidance lives in `lib/registration-playbook.js` (`STAGE_PLAYBOOK`). It is plain text — review and refine it as the registration process changes. Keep each stage section tight (under ~1200 chars) so it stays cheap to send.

## Cost / model
- Model: `SUGGEST_REPLY_MODEL` env (default `claude-opus-4-6`). For lower cost you can set it to `claude-sonnet-4-6` or `claude-haiku-4-5` and compare quality.
- The static block (rules + playbook) is prompt-cached, so repeated suggestions within a few minutes are ~90% cheaper on that portion. Because the playbook is small, each suggestion is roughly a cent regardless of cache state.
- It only runs when the RSO clicks Suggest — never automatically.

## Known follow-ups
- The rest of the app's Anthropic calls still default to the deprecated `claude-opus-4-20250514` (`ANTHROPIC_MODEL`, server.js ~179). Out of scope here; migrate separately to a current model.
- The playbook currently covers myintealth/amc/career(placement)/ahpra/pbs/commencement. Visa is aliased to the AHPRA section (visa is deferred in v1).
