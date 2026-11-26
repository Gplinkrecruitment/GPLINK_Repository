# Xero integration (read-only)

The CEO dashboard reads **sales invoices** from Xero so the Overview "Pipeline & money"
board can show what is unpaid. It never writes to Xero.

- Code: `lib/xero.js` (OAuth, token refresh, sync, doctor-name matching), routes in the
  "Xero (read-only)" block of `server.js`, tests in `tests/xero.test.js`.
- Tables (migration `20261126120000_ceo_pipeline_board.sql`): `xero_connection` (one row,
  id `default`), `xero_invoices`, `pipeline_sync_state` (row `xero`).
- Hourly sync: Vercel cron `/api/cron/xero-sync` at minute 7 (`7 * * * *`). It does nothing
  (`skipped: not_connected`) until Xero is connected.

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `XERO_CLIENT_ID` | yes | From the Xero app (developer.xero.com → My Apps, type "Web app"). |
| `XERO_CLIENT_SECRET` | yes | Same place. Without both, Connect answers 503. |
| `XERO_REDIRECT_URI` | no | Set it to the CEO host's URL below in production. If empty, the app uses `<the host you are on>/api/ceo/xero/callback`. |
| `XERO_SCOPES` | no | Space-separated. Default: `offline_access accounting.invoices.read accounting.payments.read accounting.contacts.read`. |

## Redirect URIs to register on the Xero app

- `https://ceo.admin.mygplink.com.au/api/ceo/xero/callback` (the CEO / super-admin host;
  the dashboard and these routes only answer on hosts in `SUPER_ADMIN_ALLOWED_HOSTS`)
- `http://localhost:3000/api/ceo/xero/callback` (local; run with
  `SUPER_ADMIN_ALLOWED_HOSTS=localhost`, otherwise the CEO page itself is not served locally)

The `redirect_uri` the app sends must match one of these exactly.

## Connecting / reconnecting

Open `/api/ceo/xero/connect` while signed in to the CEO dashboard (or the button that calls
it), approve in Xero, and you land back on `/pages/ceo-dashboard?xero=connected` (or
`?xero=error&reason=…`). If several organisations are shared, the one whose name contains
"GP LINK" is used, else the first. To reconnect (expired, revoked, scopes changed), just do
the same again: it overwrites the one saved connection.

`GET /api/ceo/xero/status` shows `connected`, `tenant_name`, `last_ok_at`, `last_error`
(never tokens). `POST /api/ceo/xero/sync` runs a sync now.

How it works, briefly: the access token lasts about 30 minutes and the refresh token
changes on every refresh, so each new pair is saved before it is used. The first sync reads
every sales invoice; after that each sync asks only for invoices changed since one day
before the last good sync. The doctor's name is taken from "Dr First Last" in the line text
or reference and linked to a pipeline person or app user only when exactly one matches.

Because the admin cookie is `SameSite=Strict`, the browser does not send it when Xero
redirects back. The callback is therefore checked with the signed `state` (made only for a
signed-in CEO, valid 10 minutes) plus a short-lived `SameSite=Lax` cookie set by Connect.
It then shows a tiny page that forwards to the dashboard, so the dashboard opens signed in.

## Scope assumption (unverified)

The GP Link Xero app was created in Nov 2026. Apps created on or after 2 March 2026 only get
Xero's **granular** scopes (`accounting.transactions` is split into `accounting.invoices`,
`accounting.payments`, `accounting.banktransactions`, `accounting.manualjournals`, each with
a `.read` variant). `accounting.invoices.read` and `accounting.payments.read` are listed in
Xero's own MCP-server README. We could not open Xero's scopes page to confirm the exact
read-only strings, `accounting.contacts.read` especially. If Xero rejects one, the sync
records "insufficient scope" in `pipeline_sync_state('xero').last_error`. To fix it, set
`XERO_SCOPES` to what the Xero app shows and reconnect.
