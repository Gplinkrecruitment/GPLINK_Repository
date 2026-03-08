# Claude Handoff: GP Link App (MyIntealth Sub-Stage Navigation)

## 1) Project Reality (Important)
- This repo is primarily a **Node/Express-style server + static HTML pages** app.
- Live registration pages are served from `/pages/*.html` via `server.js`.
- `Next/React/Tailwind/shadcn` scaffolding was added locally, but the production flow the user cares about is still the legacy HTML path.
- Therefore, navigation/UI fixes for live behavior must target:
  - `pages/myinthealth.html`
  - `js/registration-stepper.js`
  - and route mapping in `server.js` (if needed)

## 2) Routing + Serving Behavior
From `server.js`:
- `/registration/myintealth/*` -> `/pages/myinthealth.html`
- `/registration/amc/*` -> `/pages/amc.html`
- `/registration/ahpra/*` (or `/registration/specialist-registration/*`) -> `/pages/ahpra.html`

File serving is static from repo path. If script files are missing or blocked, page JS can fail partially.

## 3) MyIntealth Step Logic (Must Not Change)
In `pages/myinthealth.html`:
- `STAGES`:
  - `create_account`
  - `account_establishment`
  - `upload_qualifications`
  - `waiting_verification`
  - `verification_issued`
- Route mapping (`stageRouteMap`):
  - `create_account` -> `account`
  - `account_establishment` -> `establish`
  - `upload_qualifications` -> `upload`
  - `waiting_verification` -> `verify`
  - `verification_issued` -> `complete`
- `stageStatus` behavior:
  - done if completed
  - current if current stage
  - locked if previous stage incomplete
- Progress/completion logic + storage is already implemented and should stay intact.

## 4) What the User Explicitly Wants
Non-negotiable user expectations:
1. Keep existing app behavior and sections intact.
2. Change only the sub-stage nav UI behavior/appearance.
3. Do not delete content sections (video/tutorial/guidance/actions).
4. Do not break routes.
5. Do not break progression rules.
6. Always provide git push commands after changes.

## 5) What Went Wrong in This Chat
- Multiple refactors switched between:
  - external stepper script rendering,
  - fallback tab rendering,
  - inline fallback rendering.
- A commit introduced an "Unable to load step navigation" state when script loading failed.
- Another change removed fallback and produced blank nav area in production screenshot.
- User requested revert after missing/blank sections.

## 6) Current File Status to Know Before Editing
- `pages/myinthealth.html` was reverted to an earlier known state (`331b8d0` source content), which includes:
  - legacy fallback rendering (`renderLegacySubstageTabs`)
  - external stepper attempt (`GPRegistrationStepper`) with fallback.
- `pages/amc.html` is modified in working tree and should be treated as unrelated unless explicitly requested.

## 7) Safe Strategy Claude Should Follow (Recommended)
1. Work only in `pages/myinthealth.html` first.
2. Do not remove major sections or wrappers.
3. Keep a guaranteed visible fallback nav (never blank/error-only).
4. If enhancing nav UI:
   - update CSS + markup in-place,
   - preserve `stageStatus`, `syncRouteForStage`, and existing event handlers.
5. Validate route behavior for:
   - `/registration/myintealth/account`
   - `/registration/myintealth/establish`
   - `/registration/myintealth/upload`
   - `/registration/myintealth/verify`
   - `/registration/myintealth/complete`
6. Confirm locked click toast text:
   - `Complete the previous step to unlock this.`
7. Keep changes incremental and reversible.

## 8) If Claude Uses React Stepper Code
- Treat React/shadcn stepper as design reference only unless production actually routes through Next app.
- For current live app, equivalent behavior should be implemented in plain HTML/CSS/JS in `pages/myinthealth.html`.

## 9) User Communication Preferences
- User is frustrated by regressions.
- Wants exact, concrete outcomes and no over-refactor.
- Wants push command after every change.

## 10) Minimal Push Template User Expects
Use this exact format after edits:

```bash
cd "/Users/khaleed/GP LINK APP (Visual Studio)"
git add <changed-files>
git commit -m "<clear message>"
git push origin main
```
