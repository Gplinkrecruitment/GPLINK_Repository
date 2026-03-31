# GP Link — Figma Design Handoff

**App URL:** app.mygplink.com.au
**Last Updated:** 14 March 2026

---

## 1. Design System

### Color Palette

#### Primary
| Name | Hex | Usage |
|------|-----|-------|
| Blue 600 | `#2563eb` | Primary buttons, links, active states |
| Blue 700 | `#1d4ed8` | Button hover, strong accents |
| Blue 800 | `#1e40af` | Gradient start |
| Blue 900 | `#1e3a8a` | Headings, deep accents |

#### Semantic
| Name | Hex | Usage |
|------|-----|-------|
| Green 500 | `#10b981` | Success states, verified badges |
| Green 600 | `#16a34a` | Success text, done indicators |
| Orange 400 | `#f59e0b` | Warning, pending states |
| Orange 500 | `#f97316` | Warning accent |
| Red 600 | `#dc2626` | Error, failed states |
| Red 700 | `#b91c1c` | Error accent |

#### Neutrals
| Name | Hex | Usage |
|------|-----|-------|
| Slate 900 | `#0f172a` | Primary text |
| Slate 700 | `#334155` | Secondary text |
| Slate 500 | `#64748b` | Muted text, captions |
| Slate 400 | `#94a3b8` | Tertiary text, placeholders |
| Slate 200 | `#e2e8f0` | Borders, dividers |
| Slate 100 | `#f1f5f9` | Subtle backgrounds |
| Slate 50 | `#f8fafc` | Page backgrounds |
| Blue Tint BG | `#f0f4fa` | Main page background |
| White | `#ffffff` | Card backgrounds |
| White 92% | `rgba(255,255,255,0.92)` | Glass card backgrounds |
| White 72% | `rgba(255,255,255,0.72)` | Frosted glass elements |

#### Gradients
| Name | Value | Usage |
|------|-------|-------|
| Blue Card | `linear-gradient(135deg, #1e40af 0%, #3b82f6 50%, #2563eb 100%)` | AHPRA progress card |
| Purple Card | `linear-gradient(135deg, #5b21b6 0%, #8b5cf6 50%, #7c3aed 100%)` | AMC progress card |
| Green Card | `linear-gradient(135deg, #065f46 0%, #10b981 50%, #059669 100%)` | Documents progress card |
| Red Card | `linear-gradient(135deg, #9f1239 0%, #f43f5e 50%, #e11d48 100%)` | MyIntealth progress card |
| Sign In BG | `linear-gradient(160deg, #2951d5 0%, #2148ca 45%, #1f3ba6 100%)` | Auth overlay |
| Page BG | Two radial gradients: `radial-gradient(880px 520px at 10% -10%, rgba(10,132,255,0.14), transparent 56%)` and `radial-gradient(760px 460px at 100% 0%, rgba(29,78,216,0.14), transparent 58%)` over `#f0f4fa` | Page background |

---

### Typography

**Font:** Inter (Google Fonts)
**Fallback:** -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif

| Style | Size | Weight | Letter Spacing | Usage |
|-------|------|--------|----------------|-------|
| H1 | 34px | 900 | -0.03em | Onboarding hero titles |
| H1 (Page) | 20-24px | 800 | -0.01em | Page titles ("My Documents") |
| H2 | 16-22px | 800 | normal | Section headings |
| H3 | 14-15px | 700 | normal | Card titles, sub-sections |
| Body | 14px | 400 | normal | General body text |
| Body Small | 13px | 500 | normal | Secondary body text |
| Label | 11-12px | 700 | 0.03-0.06em | Uppercase labels, badges |
| Caption | 10-11px | 500-600 | normal | Small muted text |
| Nav Label | 10px | 600 | 0.04em | Bottom navigation labels |

---

### Spacing & Layout

**Page Container:** max-width 960px, centered, padding 16px horizontal
**Card Gap:** 12px between cards in grid
**Section Gap:** 16-24px between sections

**Border Radius:**
| Size | Value | Usage |
|------|-------|-------|
| XL | 20-22px | Auth shell, large modals |
| LG | 16-18px | Cards, panels |
| MD | 14px | Nav items, dropdowns |
| SM | 10-12px | Inputs, small cards, buttons |
| Pill | 999px | Badges, pill buttons, progress bars |

**Shadows:**
| Name | Value | Usage |
|------|-------|-------|
| Card | `0 18px 45px -28px rgba(2,6,23,0.55)` | Primary cards |
| Soft | `0 12px 25px -22px rgba(2,6,23,0.25)` | Header bar |
| Secondary | `0 8px 24px -16px rgba(2,6,23,0.18)` | Subtle elevation |
| Button | `0 4px 12px -4px rgba(37,99,235,0.4)` | Primary buttons |
| Large | `0 30px 70px -40px rgba(15,23,42,0.45)` | Modals, overlays |

---

## 2. Components

### Bottom Navigation Bar
- **Layout:** Fixed bottom, full width, 5 items in flex row
- **Height:** ~60px + safe area
- **Background:** White with top border `1px solid #e2e8f0`
- **Items:** Icon (22px) + Label (10px, weight 600, letter-spacing 0.04em)
- **Active state:** Blue icon + label, active indicator line (3px height, blue, rounded) above icon
- **Inactive state:** Slate 400 icon + label
- **Items:** Home | Registration | My Documents | Messages | Account
- Messages has notification badge (red circle, white count text)

### Top Header Bar
- **Background:** White
- **Border:** `1px solid rgba(226,232,240,0.82)`
- **Border Radius:** 16px
- **Shadow:** `0 12px 25px -22px rgba(2,6,23,0.25)`
- **Padding:** 14px 16px
- **Contains:** Logo (left, 176px wide) + User greeting or back button (right)
- **Greeting:** Avatar (42px circle, blue-purple gradient bg, white initials) + Name (15px, weight 700) + subtitle (12px, muted)

### Cards
- **Standard Card:**
  - Border: `1px solid #e8edf5`
  - Border Radius: 16-20px
  - Background: `rgba(255,255,255,0.92)`
  - Shadow: `0 18px 45px -28px rgba(2,6,23,0.55)`
  - Padding: 16-24px

- **Progress Card (Dashboard):**
  - Border Radius: 20px
  - Gradient background (varies by card)
  - White text
  - Contains: Icon, title, percentage, progress bar
  - Progress bar: 6px height, pill shape, white track at 20% opacity, white fill
  - Bottom has radial gradient overlay for depth

- **Document Card:**
  - Same as standard card
  - Contains: Title + Status pill (top row), Help link, Upload button / file name
  - Status pills: Pending (gray), Under Review (blue), Certified (green)

### Buttons
- **Primary:**
  - Background: `#2563eb`
  - Color: White
  - Border Radius: 12px
  - Padding: 10px 16px
  - Font: 13px, weight 700
  - Shadow: `0 4px 12px -4px rgba(37,99,235,0.4)`
  - Hover: `#1d4ed8`, translateY(-1px)
  - Active: scale(0.97)

- **Outline/Secondary:**
  - Background: White
  - Border: `1px solid #e2e8f0`
  - Color: `#334155`
  - Border Radius: 12px

- **Soft (Link-style):**
  - Background: `#eff6ff`
  - Border: `1px solid #bfdbfe`
  - Color: `#2563eb`
  - Border Radius: 999px

- **Disabled:**
  - Opacity: 0.55-0.65
  - Cursor: not-allowed

### Form Fields
- **Input/Select:**
  - Border: `1px solid #e2e8f0`
  - Border Radius: 10-12px
  - Padding: 10-12px
  - Font: 14px
  - Background: White
  - Focus: border `#2563eb`, box-shadow `0 0 0 3px rgba(37,99,235,0.1)`
  - Transition: `border-color 0.2s ease, box-shadow 0.2s ease`

### Badges / Pills
- Border Radius: 999px
- Padding: 4px 10px
- Font: 10-11px, weight 700
- Variants:
  - **Pending:** bg `#f1f5f9`, color `#64748b`
  - **Under Review:** bg `#eff6ff`, color `#2563eb`, border `#bfdbfe`
  - **Certified/Done:** bg `#ecfdf5`, color `#16a34a`, border `#bbf7d0`
  - **Action Required:** bg `#fffbeb`, color `#d97706`, border `#fde68a`
  - **Error:** bg `#fef2f2`, color `#dc2626`, border `#fecaca`

### Modals / Popups
- **Overlay:** `rgba(0,0,0,0.45)`
- **Modal Card:**
  - Background: White
  - Border Radius: 22px (top) for bottom sheets, 18px for center modals
  - Shadow: Large shadow
  - Padding: 24-32px
  - Max-width: varies (480px for scan modal, 340px for popups)

- **Cert Result Popup:**
  - Fixed center, z-index 10001
  - Width: 340px
  - Border Radius: 18px
  - Shadow: `0 20px 50px -15px rgba(0,0,0,0.3)`
  - Contains: Icon (56px, green check or red X), Title (18px, weight 800), Message (13px), OK button
  - Background animation: subtle scale-in

- **Scan Document Modal (Mobile):**
  - Slides up from bottom
  - Full width, border-radius 22px 22px 0 0
  - Max-height: 92vh
  - Contains: Choose action (Camera or Upload), File preview card, Submit button, Results screen

### Document Scan Flow
- **Steps:** Choose method -> Select/Capture file -> Scanning animation -> Result (pass/fail)
- **Scanning state:** Spinner + "Verifying certification..." text
- **Success result:** Green circle with checkmark (56px), "Scan Successful" title
- **Failure result:** Red circle with X (56px), "Scan Failed" title, issue list in red, "Try Again" button
- **Wrong document:** Red circle with X, "Wrong Document" title, shows what AI identified it as

### Help Popover (Show Me How)
- Triggered by blue link with (?) icon
- Popover card with:
  - Blue header area with title
  - Instruction text (first line bold)
  - Illustration showing certification example (stamp, signature, statement)
  - External links where applicable
  - Close button (X) top right
  - Border Radius: 16px
  - Shadow: Large

---

## 3. Pages & Screens

### 3.1 Sign In / Sign Up
- **Background:** Blue gradient overlay with subtle radial gradients
- **Layout:** Centered card (max-width ~420px)
- **Card:** White, rounded 22px, large shadow
- **Contains:**
  - Logo (centered, top)
  - Tab toggle: Sign In | Sign Up (pill style, blue active)
  - Email field
  - Password field (with show/hide toggle)
  - Submit button (full width, blue, pill shape)
  - OTP verification step (6-digit input)
  - Terms acceptance checkbox (sign up only)
- **Background blobs:** Animated colored circles with blur

### 3.2 Onboarding (8 Steps)
- **Full screen** with animated gradient background blobs
- **Steps:**
  1. Welcome (greeting + intro)
  2. Personal Details (name, DOB, phone)
  3. Country Selection (UK, Ireland, New Zealand)
  4. Qualification Selection (country-specific options)
  5. Registration Pathway (based on qualifications)
  6. Experience & Timeline
  7. Preferences (location, work type)
  8. Completion / Summary
- **Navigation:** Back/Next buttons at bottom, progress dots
- **Card:** Glass morphism (white 72% opacity, blur 10px, blue-tinted border)
- **Progress dots:** 8 dots, 10px each, blue = current, green = done, gray = future
- **Animations:** Background blobs shift colors per step, 0.8s cubic-bezier transitions
- **Step transitions:** Slide left/right with opacity fade

### 3.3 Dashboard (index.html)
- **Top:** Header bar with logo + user greeting (avatar + name)
- **Main content:**
  - 4 Progress Cards in 2x2 grid (responsive, stack on mobile):
    1. **AHPRA** (blue gradient) — registration progress %
    2. **AMC** (purple gradient) — portfolio progress %
    3. **Documents** (green gradient) — upload progress %
    4. **MyIntealth** (red/pink gradient) — setup progress %
  - Each card: Icon, title, percentage, progress bar, tap to navigate
  - Below cards: Recent activity / updates feed
- **Bottom:** Navigation bar

### 3.4 Registration
- **Header:** Back to dashboard link
- **Stepper:** Horizontal progress with numbered circles
  - Steps connected by lines
  - States: Done (green check), Current (blue, pulsing), Locked (gray)
- **Content:** Step-specific forms and information
- **Links to:** AHPRA portal, AMC portfolio, external regulatory sites

### 3.5 My Documents
- **Header:** "My Documents" title + subtitle
- **Tab Bar:** 3 tabs — "Direct to AHPRA" | "You Prepare" | "We Prepare"
  - Active tab: Blue background, white text, pill shape
  - Inactive: Light background, dark text
- **Upload Counter:** "X of Y uploaded" below tabs
- **Document Cards:** List of cards, each containing:
  - Title ("Certified copy of Primary Medical Degree")
  - Status pill (Pending / Under Review / Certified)
  - "Show me how" help link (blue, with ? icon)
  - Certification badge (if certified: green "Certified" with check icon)
  - Action: "Scan Document" button (mobile) / "Upload" button (desktop) — or filename if uploaded
  - Upload button has file input hidden inside label
- **Mobile Scan Flow:** Tapping "Scan Document" opens bottom sheet modal
- **Desktop Upload Flow:** Standard file picker, then AI verification popup
- **Cert Result Popup:** Success (green check) or failure (red X) centered overlay

### 3.6 Messages
- **Layout:** List of message threads
- **Each thread:** Avatar, sender name, preview text, timestamp, unread badge
- **Thread view:** Chat-style bubbles, blue (sent) / gray (received)
- **Notification badge:** Red circle on nav icon with unread count

### 3.7 Account
- **Hero:** Landscape illustration header image with overlay
- **Avatar:** 80px circle, gradient background, white initials, centered overlapping hero
- **Info Cards:**
  - Personal details (name, email, phone, DOB)
  - Account settings (password, notifications)
  - Country/qualification info
  - Each card: White, rounded, with edit icons
- **Actions:** Change password, sign out (red text)

### 3.8 Admin Dashboard
- **Layout:** Wider container (1240px)
- **Contains:** User management table, search/filter, status toggles
- **User rows:** Expandable with document status, qualification details
- **Actions:** Approve, flag for review, message user

---

## 4. Interaction States & Animations

### Hover
- Buttons: translateY(-1px), darker shade
- Cards: subtle lift
- Links: underline or color shift

### Active/Press
- Buttons: scale(0.97)
- Cards: scale(0.98)

### Loading
- Spinner: CSS animation, circular
- Scanning: Pulsing dots or spinner with status text
- Skeleton: Not used (immediate content load)

### Transitions
- Standard: `0.15s ease`
- Smooth: `0.2s ease`
- Elastic: `cubic-bezier(0.22, 0.9, 0.18, 1.05)`
- Blob movement: `0.8s cubic-bezier(0.22, 1, 0.36, 1)`

### Page Transitions
- Content fades in on load
- Tab switches: instant (no animation)
- Modal: slides up from bottom (mobile), fades in (desktop)

---

## 5. Responsive Breakpoints

| Breakpoint | Behavior |
|-----------|----------|
| < 640px | Mobile layout: single column, bottom nav, "Scan Document" button visible, "Upload" button hidden |
| >= 640px | Desktop layout: multi-column where applicable, "Upload" button visible, "Scan Document" hidden |
| ~960px | Max content width for main pages |
| ~1240px | Max content width for admin |

### Mobile-Specific
- Bottom navigation bar (fixed)
- "Scan Document" buttons (class: `mobile-only`)
- Full-width cards
- Bottom sheet modals

### Desktop-Specific
- "Upload" buttons (class: `desktop-only`)
- Center-aligned modals
- Hover states active
- Wider card grids

---

## 6. User Flows

### New User Flow
1. **Sign Up** (email + password + terms) -> OTP verification
2. **Onboarding** (8 steps: details, country, qualifications, preferences)
3. **Dashboard** (see progress cards, start tasks)
4. **Documents** (upload/scan required documents)
5. **Registration** (step-by-step AHPRA/AMC process)

### Document Upload Flow (Mobile)
1. Tap "Scan Document" on a document card
2. Modal slides up: Choose "Use Camera" or "Upload File"
3. If camera: Viewfinder opens with guide frame + document title
4. If upload: File picker (images + PDFs)
5. Preview file name/size, tap "Scan with AI"
6. Scanning animation ("Verifying certification...")
7. Result: Green check (success) or Red X (failure with reasons)
8. On success: Document attached, card updates to show filename + status

### Document Upload Flow (Desktop)
1. Click "Upload" button on document card
2. File picker opens (images + PDFs)
3. Card shows "Verifying certification..." spinner
4. Result popup appears centered: Green check or Red X
5. On failure: Document NOT attached, user can retry (up to 6 attempts before manual review)

### Restricted Mode
- When `account_status = 'under_review'`
- Only MyIntealth + Account pages accessible
- Other nav items show lock icon
- Tapping locked items shows "Account under review" popup
- Content areas blurred on restricted pages
- Copy/paste disabled

---

## 7. Assets Required

### Logo
- `gp-link-logo.png` — Primary brand logo (used in header, ~176px wide)
- Transparent background variant available

### Icons
- All icons are **inline SVGs** (no icon font or sprite sheet)
- Style: Stroke-based, 2px stroke width, round line caps
- Size: 20-24px typical, 56px for result indicators
- Color: `currentColor` (inherits from parent)
- Common icons: Home, Clipboard, FileText, MessageCircle, User, Camera, Upload, Check, X, Lock, ChevronRight, AlertCircle, HelpCircle

### Illustrations
- Account page header: Landscape photo/illustration
- Certification example: Inline SVG illustration showing stamp, signature, statement on a document
- No other illustrations (UI is primarily card-based)

---

## 8. Countries & Document Requirements

### UK (GB)
Required documents (You Prepare tab):
- Certified copy of Primary Medical Degree (certNote)
- Certified copy of MRCGP (certNote)
- Certified copy of CCT (certNote)
- Certificate of Good Standing
- Criminal History Check
- CV (Signed and dated)

### Ireland (IE)
Required documents (You Prepare tab):
- Certified copy of Primary Medical Degree (certNote)
- Certified copy of MICGP (certNote)
- Certified copy of CSCST (certNote)
- ICGP Confirmation Letter (certNote)
- Certificate of Good Standing
- Criminal History Check
- CV (Signed and dated)

### New Zealand (NZ)
Required documents (You Prepare tab):
- Certified copy of Primary Medical Degree (certNote)
- Certified copy of FRNZCGP (certNote)
- RNZCGP Confirmation Letter (certNote)
- Certificate of Good Standing
- Criminal History Check
- CV (Signed and dated)

**certNote** = requires certified copy with solicitor/notary stamp. AI checks certification markings on image uploads.

---

## 9. AI Verification Behavior (for prototyping)

### Image Upload (certNote docs)
1. Show spinner: "Verifying certification..."
2. After ~2-5 seconds:
   - **Pass:** Green check popup, document attached as "Certified"
   - **Fail (wrong doc):** Red X, "Wrong Document — This appears to be [X], not [Y]"
   - **Fail (not certified):** Red X, "Scan Failed — The document does not appear to be properly certified"
3. On fail: document NOT attached, user retries

### PDF Upload (certNote docs)
1. Show spinner: "Verifying document..."
2. After ~2-5 seconds:
   - **Pass (correct doc):** Green check, "Document Uploaded. Certification will be verified manually."
   - **Fail (wrong doc):** Red X, "Wrong Document — This appears to be [X], not [Y]"
3. On fail: NOT attached, up to 6 attempts before manual review fallback

### Non-certNote docs (CV, Criminal History, Certificate of Good Standing)
- Standard upload, no AI verification
- Immediately attached with "Under Review" status
