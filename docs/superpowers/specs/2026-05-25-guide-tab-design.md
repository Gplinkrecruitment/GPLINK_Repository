# Guide Tab — RSO Admin

**Date:** 2026-05-25
**Status:** Approved

## Overview

Add a "Guide" tab to the RSO admin page where Scribe tutorial embeds are organized into folders. All admin users can view guides. Only CEO can add/edit/remove folders and guides.

## Layout

**Approach A — Folder list + slide-out panel:**
- Left side: vertical list of expandable folders with guide counts
- Right side: slide-out panel showing selected Scribe embed (iframe)
- Follows existing admin patterns (similar to GP list + detail panel)

## Data Model

### `guide_folders` table
- `id` (uuid, PK)
- `name` (text, not null)
- `sort_order` (integer, default 0)
- `created_at` (timestamptz)

### `guide_items` table
- `id` (uuid, PK)
- `folder_id` (uuid, FK → guide_folders.id, ON DELETE CASCADE)
- `title` (text, not null)
- `scribe_url` (text, not null)
- `sort_order` (integer, default 0)
- `created_at` (timestamptz)

### Seed data (3 folders)
1. Onboarding (sort_order: 0)
2. Guiding GP through Registration (sort_order: 1)
3. Completing Tasks (sort_order: 2)

## API Endpoints

All under `/api/admin/guide/`:
- `GET /api/admin/guide/folders` — list all folders with items
- `POST /api/admin/guide/folders` — create folder (CEO only)
- `PUT /api/admin/guide/folders/:id` — rename folder (CEO only)
- `DELETE /api/admin/guide/folders/:id` — delete folder + items (CEO only)
- `POST /api/admin/guide/items` — create guide item (CEO only)
- `PUT /api/admin/guide/items/:id` — update guide item (CEO only)
- `DELETE /api/admin/guide/items/:id` — delete guide item (CEO only)

Auth: all require valid admin session. Mutations require CEO role.

## UI

### Tab
- New `view-tab` with `data-view="guide"` placed after Support tab
- Visible to all admin users (no conditional display)

### Guide Panel (`guidePanel`)
- Folder list on the left, slide-out detail on the right
- Folders are collapsible (click to expand/collapse)
- Expanded folder shows guide titles as clickable rows
- Click a guide → loads Scribe iframe in the slide-out panel
- CEO sees: "Add Folder" button, "Add Guide" button per folder, edit/delete icons
- Non-CEO: read-only view, no management controls

### Empty states
- No folders: "No guides yet" message
- Empty folder: "No guides in this folder" message
- No guide selected: placeholder in slide-out panel
