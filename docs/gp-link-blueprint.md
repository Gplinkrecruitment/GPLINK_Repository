# GP Link Blueprint

Status: Working draft v0.1  
Date: 2026-03-20

This document is the first operating blueprint for GP Link. It is intentionally practical.

The goal is to make product, data, dashboards, permissions, and integrations clear enough that engineering can build the right infrastructure in phases without redesigning the whole system every week.

This is not the final truth. It is the starting point.

## 1. Product Surfaces

### Public Career Surface
- Used by: prospective GPs and general visitors
- Purpose: discover GP Link roles and understand the value proposition
- Must do:
  - show live roles synced from Zoho Recruit
  - let GPs view role details safely
  - direct GPs into sign up / application flow
  - protect internal-only information
  - support marketing and recruitment conversion

### Candidate App
- Used by: overseas GPs and relocating doctors
- Purpose: manage the full candidate journey from registration to application and onboarding
- Must do:
  - sign up and authenticate
  - complete onboarding
  - upload and manage documents
  - track registration / verification progress
  - apply for jobs
  - raise support requests

### Employee Admin
- Used by: recruiters, operations staff, support staff
- Purpose: run the day-to-day business
- Must do:
  - review GP registrations
  - monitor certificate / document verification queues
  - manage support tickets
  - view candidate progress and unblock cases
  - monitor Zoho Recruit sync health
  - manage operational workloads

### CEO Dashboard
- Used by: CEO / super admin only
- Purpose: monitor business health, risk, demand, and executive decisions
- Must do:
  - see pipeline health at a glance
  - see risk and backlog
  - see role demand and application momentum
  - see operational bottlenecks
  - monitor integration health
  - approve high-risk actions later

## 2. Platform Principles

- One source of truth per domain.
- Staff admin and CEO dashboard are different products, not the same screen with different colors.
- Zoho Recruit should stay strong as an external recruitment system, but GP Link must own the candidate journey and reporting layer.
- Dashboards should be derived from operational data, not manually maintained.
- AI is an enrichment layer later, not the first layer and not the source of truth for core metrics.
- Least privilege always applies.
- Practice identity is a protected commercial asset and must be disclosed using minimum-necessary reveal rules.

## 3. Source Of Truth Matrix

### Identity and Access
- User authentication: Supabase Auth
- Staff/CEO roles: `public.user_roles`
- Admin host access: environment allowlists plus server-side role checks

### Candidate Data
- Core candidate profile: `public.user_profiles`
- Candidate onboarding state: `public.user_state` for now
- Candidate progress / pathway state: app-derived from onboarding + document state
- Candidate support history: app-side support cases tied to candidate state

### Recruitment Data
- Live jobs / public roles: `public.career_roles`
- Job source of truth: Zoho Recruit
- Candidate applications: `public.gp_applications`
- External candidate / application IDs: Zoho IDs stored locally for linking

### Dashboard Data
- Employee admin metrics: derived from candidate state, support state, and Zoho sync status
- CEO metrics: derived reporting layer built from Supabase + Zoho-derived records

### Future Communication Data
- Email data: future ingestion layer
- DoubleTick / WhatsApp data: future ingestion layer
- AI summaries / discrepancy detection: future enrichment layer only

## 4. Core Entities

### Candidate
- `user_id`
- `email`
- `phone`
- `registration_country`
- `zoho_candidate_id`
- `status`
- `pathway_stage`
- `last_active_at`

### Candidate State
- onboarding progress
- document progress
- qualification / registration journey
- support state
- action-required flags

### Career Role
- `career_role_id`
- `provider`
- `provider_role_id`
- `title`
- `practice_name`
- `confidentiality_tier`
- `identity_reveal_stage`
- `location`
- `is_active`
- `support_summary`

### Application
- `id`
- `user_id`
- `career_role_id`
- `provider_role_id`
- `zoho_candidate_id`
- `zoho_application_id`
- `status`
- `practice_identity_status`
- `practice_identity_revealed_at`
- `applied_at`

### Support Ticket
- `ticket_id`
- `candidate_id`
- `category`
- `priority`
- `status`
- `updated_at`

### Admin User
- `user_id`
- `email`
- `role`
- `allowed_host_scope`

### Integration Connection
- provider
- connection status
- token refresh state
- last successful sync
- last error

## 5. Workflow Rules

### Candidate Lifecycle
- When a GP signs up, create a Supabase auth user and `user_profiles` row.
- Candidate onboarding and progress live in the app and are reflected into dashboard reporting.
- Support tickets stay linked to the candidate record.

### Recruitment Lifecycle
- Jobs are pulled from Zoho Recruit into `career_roles`.
- When a GP applies, GP Link creates a local `gp_applications` row.
- If needed, GP Link creates or links the Zoho candidate.
- GP Link creates a Zoho application and stores the external IDs.

### Role Confidentiality / Reveal Rules
- Default role setting is `protected`, not fully public.
- `public` tier can show the practice name from the first role view because the practice is already openly market-facing and GP Link is not relying on identity secrecy for protection.
- `protected` tier hides the practice name, website, street address, phone, email, clinician names, and exact identifying details until the candidate is qualified and has moved into a recruiter-managed application stage.
- `strict` tier hides the same details until GP Link has screened the candidate and the practice has agreed to progress or interview them.
- Public and pre-application views can show only non-identifying information such as role title, broad location, billing model, practice type, support summary, earnings range, and generic culture / workload descriptors.
- Signed-in candidates who have not completed onboarding should see the same protected version as the public surface.
- Candidates can apply or request introduction without seeing the practice identity first.
- Before identity reveal, the candidate must have a verified account, completed the required onboarding threshold, and accepted a confidentiality / non-circumvention acknowledgment in-product.
- For `protected` roles, practice identity can be revealed when GP Link decides the candidate is submission-ready and is about to introduce or has introduced the candidate to the practice.
- For `strict` roles, practice identity should be revealed only after recruiter approval and either practice approval to progress or a confirmed interview step.
- Revealed identity should be scoped to the candidate's own application record, not globally unlocked across all roles.
- Direct practice contact details should remain hidden until an interview or direct handoff step requires them.
- Every reveal action should be timestamped and audit logged with candidate, role, admin actor if any, and reveal reason.

### Admin / CEO Rules
- Employee admin is operational.
- CEO dashboard is executive and read-mostly.
- Only `super_admin` can use the CEO host.
- Employee admins should not see CEO-only executive metrics.
- Future approval actions should be isolated to CEO or explicit approval roles.

### Metric Rules
- `Active pipeline` = candidates not marked complete.
- `Stalled` = no candidate activity for defined threshold.
- `Verification backlog` = candidates pending verification.
- `Applications 30d` = applications created in last 30 days.
- `Live roles` = active roles in local `career_roles`.

## 6. Dashboard Definitions

### Employee Admin Dashboard
- Purpose: run operations
- Core widgets:
  - total GPs
  - pending verifications
  - open support tickets
  - average progress
  - Zoho Recruit sync health
  - registration list
  - verification queue
  - support queue

### CEO Dashboard
- Purpose: run the business
- Core widgets:
  - active pipeline
  - new registrations in 30 days
  - live roles
  - applications in 7 / 30 days
  - stalled candidates
  - action-required cases
  - urgent ticket count
  - pipeline funnel
  - country / market footprint
  - practice demand concentration
  - Zoho connection health

### Candidate App Dashboard
- Purpose: help the GP move through the journey
- Core widgets:
  - onboarding progress
  - document status
  - registration pathway stage
  - active applications
  - support / help

## 7. Integrations

### Zoho Recruit
- Role: recruitment system of record for roles and linked external application workflow
- Data into GP Link:
  - job openings
  - role metadata
  - external IDs
- Data out of GP Link:
  - candidate records
  - applications
- Notes:
  - keep sync observable
  - log failures clearly
  - keep local mirror tables for reporting and UX speed

### Email
- Phase: later
- Role: communication evidence and engagement metrics
- Likely use:
  - Gmail API or Microsoft Graph
- Usage:
  - fetch communication metadata and later message bodies where appropriate
  - map messages to candidates
  - feed operational reporting and AI summaries

### DoubleTick
- Phase: later
- Role: WhatsApp / messaging activity and engagement signal
- Usage:
  - ingest chat messages and webhook events
  - map activity to candidate identity
  - support response-time metrics and engagement visibility

### AI
- Phase: later
- Role:
  - entity resolution
  - discrepancy detection
  - summarization
  - executive brief generation
- Not for:
  - primary source of truth
  - direct financial reporting
  - replacing deterministic workflow logic

## 8. Permissions Model

### Candidate
- Can view and edit their own profile, documents, applications, and support history
- Can only view practice identity for roles where the reveal conditions have been met for their own application

### Staff
- Can view candidate operational data relevant to their work
- Can update support and operational statuses
- Cannot access CEO-only analytics

### Admin
- Can manage employee-level admin operations
- Can access candidate operations and Zoho admin functions
- Cannot access CEO-only host unless also `super_admin`

### Super Admin
- Can access CEO host
- Can view executive metrics
- Can manage high-risk permissions and infrastructure-level admin actions later

## 9. Proposed Data Direction

Short term:
- keep using `user_profiles`, `user_state`, `career_roles`, `gp_applications`, and `user_roles`
- derive dashboards from those sources

Medium term:
- normalize support tickets into dedicated tables
- normalize candidate pathway events into dedicated tables
- add integration connection / sync log tables
- add audit log tables for admin and CEO actions
- add role identity reveal event logging and candidate acknowledgment records

Long term:
- add communication ingestion tables for email + DoubleTick
- add reporting snapshot tables for heavier analytics
- add AI output tables with confidence and review status

## 10. Build Order

### Phase 1: Foundation
- stabilize candidate app, employee admin, and CEO dashboard boundaries
- stabilize roles and host access
- stabilize Zoho Recruit job/application flow
- stabilize local reporting layer for dashboard metrics

### Phase 2: Operational Hardening
- normalize support tickets
- normalize candidate progress events
- add audit logging
- add exports and executive report quality improvements
- define approvals model

### Phase 3: Communication + AI Layer
- connect email
- connect DoubleTick
- unify communication timeline
- add AI reconciliation and summaries
- add anomaly detection and confidence scoring

## 11. What We Should Not Do Yet

- Do not fully polish every frontend screen before the data model is stable.
- Do not build AI before deterministic data joins are working.
- Do not let Zoho-only views dictate the entire GP Link product.
- Do not duplicate the same dashboard for staff and CEO.

## 12. Current Assumptions To Confirm Later

- Zoho Recruit stays the source of truth for jobs.
- GP Link stays the source of truth for onboarding, candidate progress visibility, and support workflow.
- CEO dashboard remains read-mostly in phase 1.
- Revenue / placements / finance metrics come later once placement events and financial sources are defined clearly.
- Email and DoubleTick are phase 3, not phase 1 blockers.

## 13. Immediate Next Step

Use this document to decide phase 1 scope only.

Recommended next engineering step:
- turn this blueprint into a phase 1 implementation plan
- label each item as `now`, `later`, or `not in scope`
- then build phase 1 in sequence:
  - candidate app core
  - employee admin core
  - CEO metrics layer
  - Zoho hardening
