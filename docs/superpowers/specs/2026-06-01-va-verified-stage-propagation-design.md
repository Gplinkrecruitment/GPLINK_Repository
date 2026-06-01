# VA Verified Stage Propagation — Design Spec

**Date:** 2026-06-01
**Status:** Approved

---

## Overview

When the CEO changes the "VA Verified Stage" dropdown on a GP's case management panel and saves, it propagates to the GP's actual registration progress — completing prior stages, unlocking the selected stage, resetting later stages, and notifying the GP.

---

## Behaviour

### Forward Movement

Setting the verified stage to a later stage (e.g., from MyIntealth to AHPRA):
- Marks all prior stages as **complete** by setting their completion flags to `true`
- Unlocks the selected stage so the GP can access it
- GP sees completed checkmarks on prior steps in the registration stepper

### Backward Movement

Setting the verified stage to an earlier stage (e.g., from AHPRA back to AMC):
- **Locks** all stages after the selected one
- **Clears** completion flags for those later stages (full reset)
- GP is effectively returned to the selected step

### No Change / Clear

Setting to "Not verified" has no effect on the GP's state — it only clears the admin label.

---

## Stage Completion Mapping

The registration journey has these stages in order:
1. **Secure Placement** (career) — no progress object, tracked via `gp_career_state`
2. **MyIntealth** — `gp_epic_progress.completed.verification_issued`
3. **AMC** — `gp_amc_progress.completed.qualifications_verified`
4. **AHPRA** — `gp_ahpra_progress.completed.verification_issued`
5. **Visa** — no progress object yet
6. **PBS & Medicare** — no progress object yet
7. **Commencement** — no progress object yet

When the CEO selects a stage, all stages **before** it are marked complete:

| Selected Stage | EPIC (MyIntealth) | AMC | AHPRA | Later Stages |
|---|---|---|---|---|
| myintealth | in progress | locked | locked | locked |
| amc | complete | in progress | locked | locked |
| career | complete | complete | locked | locked |
| ahpra | complete | complete | in progress | locked |
| visa | complete | complete | complete | locked |
| pbs | complete | complete | complete | in progress |
| commencement | complete | complete | complete | complete |

---

## Server-Side Logic

### Trigger

The `PUT /api/admin/case` endpoint detects when `gp_verified_stage` is in the patch body and has a non-empty value different from "Not verified".

### Steps

1. Fetch the GP's `user_id` from the case
2. Fetch the GP's current `user_state` from Supabase
3. Parse the three progress objects: `gp_epic_progress`, `gp_amc_progress`, `gp_ahpra_progress`
4. Based on the selected stage, update completion flags:

**For stages that should be complete:**
- Set `gp_epic_progress.completed.verification_issued = true` and `gp_epic_progress.stage = "verification_issued"`
- Set `gp_amc_progress.completed.qualifications_verified = true` and `gp_amc_progress.stage = "qualifications_verified"`
- Set `gp_ahpra_progress.completed.verification_issued = true`

**For stages that should be reset (backward movement):**
- Clear the completion flags: set `completed.verification_issued = false` or `completed.qualifications_verified = false`
- Reset the stage to the initial value: `"create_account"` for EPIC, `"create_portfolio"` for AMC

5. Update `gp_registration_return_overrides` to unlock all stages up to and including the selected one
6. Write the updated state back to Supabase via `user_state` upsert
7. Create an in-app notification for the GP

### State Update Function

```
function buildStageState(selectedStage):
  stages_in_order = [myintealth, amc, career, ahpra, visa, pbs, commencement]
  selected_index = stages_in_order.indexOf(selectedStage)
  
  for each stage at index i:
    if i < selected_index:
      mark stage as COMPLETE
    elif i == selected_index:
      mark stage as IN PROGRESS (unlocked, not complete)
    else:
      mark stage as LOCKED (reset completion flags)
```

---

## GP Notification

When the stage is changed, create an in-app notification visible to the GP:

- **Message:** "Your registration progress has been updated by your GP Link team."
- **Delivery:** Stored via the existing notification/alert system (`updates-sync.js`)
- **Visibility:** Shows as a banner/alert when the GP next opens the app

---

## API Changes

### Modified: `PUT /api/admin/case`

After the existing case PATCH and timeline logging, add a block that:
1. Checks if `patch.gp_verified_stage` is set and non-empty
2. Fetches the GP's user_state
3. Applies the stage completion mapping
4. Upserts the updated user_state
5. Creates an in-app notification

This block runs inline (awaited, not fire-and-forget) to ensure the state is updated before the response is sent.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Stage set to "Not verified" (empty) | No state changes — only clears the admin label |
| GP has never opened the app (no user_state) | Create initial state with the correct completion flags |
| Stage set to same value as current | No-op — skip the state update |
| Career stage selected but no placement data | Still marks EPIC + AMC as complete; career page accessible |

---

## Files Changed

- `server.js` — Stage propagation logic in `PUT /api/admin/case`, in-app notification creation
- No frontend changes needed — `state-sync.js` already pulls state from Supabase on load, and the registration stepper already reads the progress objects
