# Admin Medical Centres + Vaulted Tabs

**Date:** 2026-04-25
**Status:** Approved

## Overview

Three changes to the admin dashboard:
1. Vault (hide + disable) Interviews, Applications, Support, and Tools tabs
2. Relocate super-admin-only tools (Gmail setup, integrations) behind a gear icon in the admin header
3. Add a new Medical Centres tab showing practices with job openings from Zoho Recruit

## 1. Vault Tabs

### What gets removed
- Nav tabs: Interviews, Applications, Support, Tools
- Their corresponding `<div class="view-panel">` sections in `admin.html`
- All JS event handlers, renderers, and data-fetching logic tied to these views

### What stays
- All backend API routes remain untouched (no breaking changes)
- Super-admin-only tool buttons (Gmail setup, Zoho Recruit connect/sync, Zoho Sign, etc.) move to a new super-admin utility area

### Super Admin Utility Area
- Small gear/cog icon in the admin header bar, visible only to super admin (`khaleedmahmoud1211@gmail.com`)
- Clicking it opens a dropdown/panel with the tool buttons that were previously in the Tools tab
- Only renders when the logged-in admin session matches the super admin email

## 2. Medical Centres Tab

### Navigation
- New tab "Medical Centres" in the admin nav bar, positioned after "GPs"
- `data-view="medical-centres"`

### List View (default)
Cards grouped by medical centre (unique practice/client from Zoho Recruit job openings).

Each card displays:
| Field | Source |
|-------|--------|
| Practice Name | `career_roles.practice_name` (from Zoho `Practice_Name` / `Organisation_Name`) |
| Client Name | `career_roles.client_name` (from Zoho `Client_Name` / `Account_Name`) |
| Location | `career_roles.location` |
| Work Type | `career_roles.work_type` |
| Benefit 1 | `career_roles.benefit_1` |
| Benefit 2 | `career_roles.benefit_2` |
| Benefit 3 | `career_roles.benefit_3` |
| Address | `career_roles.address` |
| Billing Type | `career_roles.billing_type` |
| Open Positions | Count of open job openings for this centre (badge) |

Cards are clickable — clicking opens the detail view.

### Detail View
Header with all medical centre fields from the card, plus a sub-nav:

**Sub-nav tabs:**
- **Overview** (default) — List of all job openings at this centre, each showing job title, status (open/closed), and description
- **Applications** — Table of active applications for any job opening at this centre

### Applications Table Columns
| Column | Details |
|--------|---------|
| GP Name | Clickable link — opens the GP's profile page (`/pages/admin.html?view=gps&id={user_id}`) in a new tab |
| Job Opening | Title of the position applied for |
| Status | Application status (applied, interview_scheduled, offer, placement_secured, etc.) |
| Date Applied | `applied_at` timestamp formatted as readable date |

## 3. Backend API

### `GET /api/admin/medical-centres`
Returns medical centres aggregated from `career_roles` where status is open.

Response shape:
```json
[
  {
    "id": "centre-slug-or-hash",
    "practice_name": "...",
    "client_name": "...",
    "location": "...",
    "work_type": "...",
    "benefit_1": "...",
    "benefit_2": "...",
    "benefit_3": "...",
    "address": "...",
    "billing_type": "...",
    "open_positions": 3,
    "job_openings": [
      { "id": "...", "title": "...", "status": "open", "description": "..." }
    ]
  }
]
```

### `GET /api/admin/medical-centres/:id/applications`
Returns applications for all job openings at the specified medical centre.

Response shape:
```json
[
  {
    "application_id": "...",
    "user_id": "...",
    "gp_name": "...",
    "job_title": "...",
    "status": "applied",
    "applied_at": "2026-04-20T10:00:00Z"
  }
]
```

Both endpoints require admin session auth (same as other `/api/admin/*` routes).

## 4. Data Source

All medical centre data derives from the existing Zoho Recruit sync that populates the `career_roles` table. No new Zoho API calls needed — we query the already-synced data.

Fields that may need to be added to the Zoho sync if not already stored:
- `work_type`
- `address`
- `billing_type`

These fields need to be checked against the current sync mapping and added if missing.

## 5. Scope Exclusions

- No changes to backend API routes (vault is UI-only)
- No changes to the user-side application flow
- No new Zoho Recruit API integration (uses existing synced data)
- No changes to the GP detail view tabs (Tasks, Documents, Journey, Notes)
