# Update 1 — 12 May 2026

## Visa Step Re-enabled

- Visa Application added back to the user journey as **Step 5** (between AHPRA Registration and PBS & Medicare)
- PBS & Medicare renumbered to Step 6, total journey steps updated to 6
- The Visa page is **always accessible** (never locked behind prerequisites)
- New informational page showing the **Subclass 482 → Subclass 186 → Permanent Residency → Australian Citizenship** pathway with:
  - Visual timeline with animated blue glow
  - Time durations between each step (2 years, 4 years)
  - Intro text referencing CV and GMC registration review
  - "Speak to our team" link for GPs interested in alternative visa pathways — opens a prefilled support ticket modal
- On desktop, the dark header is hidden (app shell provides navigation)
- On mobile, the title and description paragraph are hidden (the mobile header already provides context)

## Support Ticket Improvements

- **WhatsApp confirmation**: When a GP submits a support ticket from any page, they now receive a WhatsApp message confirming receipt and that a registration support agent will be in touch via email or WhatsApp
- **Immediate sync**: Support tickets submitted from the visa page now force-push state to the server immediately, so the admin dashboard sees them right away
- **Admin "Open Chat"**: The admin Support tab now shows "Open Chat" (opens DoubleTick conversation) as the primary action instead of "Email GP". Email is shown as a secondary fallback
- **DoubleTick URL resolution**: Now runs for ALL support items (In-App and WhatsApp), not just WhatsApp-sourced tickets
- Visa added to `STAGE_ORDER` in admin dashboard so visa-related tasks appear properly in the GP profile

## Tutorial Video Styling

- Unified tutorial video styling across all registration steps (MyIntealth, AMC, AHPRA) to match the AHPRA reference:
  - AMC: `max-height` increased from 500px to 2000px (was cropping videos)
  - MyIntealth: `max-height` increased from 800px to 2000px (was cropping videos)
  - MyIntealth: removed extra `display: block` and `controlsList="nodownload"` to match AHPRA

## MyIntealth Step Tweaks

- "Download my documents" button moved below the time estimate text
- Button pulse animation removed
- Button styled blue (accent colour) to match the primary CTA style on other steps

## Gmail Email-to-Ticket Pipeline Fixed

- **Root cause**: `CRON_SECRET` environment variable was missing on Vercel, causing all Gmail cron endpoints (`process-gmail`, `renew-gmail-watch`, `gmail-diagnostic`) to return **401 Unauthorized**
- **Fix**: All cron endpoints now fall back to `ZOHO_RECRUIT_SYNC_CRON_SECRET` (which is set and working) when `CRON_SECRET` is unavailable
- **Cron frequency increased**:
  - `process-gmail` now runs **every 15 minutes** (was once daily at 8am UTC) — emails are picked up even if the Gmail push watch lapses
  - `renew-gmail-watch` now runs **every 6 hours** (was once daily) — prevents the watch from expiring

## Zoho Recruit Scopes Fixed

- **Root cause**: Zoho does not echo back granted scopes in the token exchange response. The code stored whatever Zoho returned (empty), and `mapZohoConnectionRow` treated an empty array as valid (it IS an array), so the fallback to default scopes never triggered. Every subsequent read and write perpetuated the empty array.
- **Fix**: `mapZohoConnectionRow` now checks `row.scopes.length > 0` before using the DB value — if empty, it falls back to the required scopes (`ZohoRecruit.modules.all`, `ZohoRecruit.search.READ`)
- `ZohoRecruit.search.READ` moved from optional to required so it's included in the OAuth request
- Both OAuth callback paths (RSO admin and CEO admin) fixed with the same fallback logic
- No disconnect/reconnect needed — the fix takes effect on next page load

## Notes & Documents Tabs

- Notes section separated into its own tab on the GP profile
- New **Documents tab** with Google Drive file grid, preview overlay, and file upload
- Removed duplicate old qualifications viewer (`renderGpDocumentsPane`) — replaced by Drive-based Documents tab

## Admin Dashboard

- Drive list-files and upload endpoints added, scope widened to include Google Drive
- Escalated and blocked tasks now visible on the GPs tab (VA dashboard API was excluding them)
- Multiple escalation bug fixes (reason not shown, task vanishing from RSO view after escalate, escalation fields missing before migration)

## Technical Hub (New)

- New **Technical tab** in admin dashboard with:
  - Integration status monitoring (Gmail, Zoho Recruit, Zoho Sign, Supabase, Anthropic, DoubleTick, Google Drive)
  - System bugs tracker
  - User error capture
- `error-reporter.js` added to all HTML pages for automatic client-side error capture
- AI code scanner GitHub Action — daily + push security/reliability scan
- Auto-assign SLA due dates and time-based urgency for tasks

## Known Issues

- Vercel GitHub App integration is broken (since April 2026) — deployments rely on deploy hook via GitHub Action, which may cache stale commits. Permanent fix: re-authorize the Vercel GitHub App at github.com → Settings → Applications → Vercel
