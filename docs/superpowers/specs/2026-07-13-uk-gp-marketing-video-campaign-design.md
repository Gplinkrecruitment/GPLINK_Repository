# GP Link — "UK → Australia" GP Marketing Video Campaign

**Design spec · 2026-07-13**

## Purpose

Produce **10 marketing videos** aimed at UK-trained GPs considering a move to
Australia. Seven are lifestyle/recruitment ads for Facebook & Instagram paid
placements; three showcase how the GP Link app makes the move easy. Videos are
generated with the **Higgsfield** connector. This document is the creative +
reference-media blueprint. It defines the settings, the reusable reference
assets, and per-video briefs. It does **not** contain the final Higgsfield
prompts — those are written in a later phase using **Claude Fable 5**, which
consumes this spec.

## Division of labour

| Phase | Model / tool | Output |
|-------|--------------|--------|
| 1. Plan (this doc) | Opus | Settings, reference-asset list, per-video briefs |
| 2. Reference build | Higgsfield `generate_image` + `media_upload` | Character portraits, location plates, uploaded real logo + app screenshots |
| 3. Prompt writing | **Claude Fable 5** | Exact per-shot `generate_video` prompts referencing the locked assets |
| 4. Generation | Higgsfield `generate_video` | Raw clips |
| 5. Assembly | (editor) | Final videos with captions, VO, logo end-card, per-format exports |

## Campaign spine

**"A career upgrade that's also a life upgrade."** Every video is a
*before → after*: the grey, burnt-out NHS grind on one side; sunshine, space,
respect and an early finish on the other — with GP Link as the effortless,
free bridge across. This is drawn directly from the live marketing copy
("you didn't train 10 years to burn out", "beaches, sunshine and space",
"top GPs earn up to $1M", "a permanent future, not just a posting", "every step
handled, from first call to first day").

Individual ads may lean into secondary angles — pure aspiration
("Australia is waiting"), or reassurance/ease ("every step handled") — for
variety, but all resolve to the same CTA and end-card.

## Brand skin (applies to all 10)

- **Logo:** navy "GP" + sky-blue "Link" with the blue chain-link mark.
  Real assets: `media/images/gp-link-logo.png` and
  `media/images/GP Link Logo (BG removed) (1).png`. Logo end-card closes every video.
- **Palette:** primary blue `#2563eb`, deep blue `#1d4ed8`, navy ink `#0f172a`,
  success green `#16a34a`, clean white surfaces.
- **Grade:** bright, warm, blue-sky, golden-hour. Australia scenes are luminous
  and open; UK "before" scenes are cool, grey, cramped.
- **Captions:** brand-blue, bold, high-contrast, baked in (sound-off autoplay).
- **CTA:** "Create your free account · free forever for doctors" (2-minute sign-up).

## Reusable reference kit (built once in Phase 2, reused across all 10)

### A. Characters — a DISTINCT GP per video

Each video features its **own** GP character (no recurring hero), so the campaign
shows a broad, diverse cross-section of the real UK GP workforce and lets more
viewers see themselves. Each GP gets one portrait reference set
(front + 3/4, consistent soft lighting) generated in Phase 2 and reused across
that video's shots for face consistency. Names/looks below are **illustrative
starting points** for the reference-image generation — adjustable.

| Video | GP character (illustrative) | Age | Look / situation |
|-------|-----------------------------|-----|------------------|
| 1 | Dr James Fletcher | 34 | White British, athletic, outdoors/surf; solo. Burnout → beach. |
| 2 | Dr Ruth Adeyemi | 38 | British-Nigerian, husband + 2 young kids. Space / family future. |
| 3 | Dr Priya Nair | 45 | British-Indian, senior GP worn down by NHS admin; respect + earnings. |
| 4 | Dr Aisha Khan | 31 | British-Pakistani, solo, adventurous. UGC selfie testimonial. |
| 5 | Dr Tom Whitaker | 29 | White British, early-career, punchy. UGC myth-buster. |
| 6 | Dr Ben Okafor | 36 | British-Nigerian, calm, partner at home. Day-in-life. |
| 7 | Dr Emma Lawson | 41 | White British, teenage kid, regional-town warmth. Day-in-life. |
| A | Dr Nadia Rahman | 33 | British-Bangladeshi, relatable everywoman GP. Flagship app hero. |
| B | Dr Chris Bennett | 37 | White British. App commercial lead. |
| C | Dr Leila Haddad | 30 | British-Lebanese, quick/punchy. Short app cut. |

**Recurring support character:** **RSO Sarah** — friendly Australian
Registration Support Officer, warm and reassuring, appears in the 3 app videos
(A, B, and briefly C) as the human "your dedicated support officer" face. One
portrait reference set, reused.

### B. Real brand + app assets (upload, don't fabricate)

- GP Link logo + BG-removed version (above) → end-card.
- Real app screenshots, captured live before Phase 2:
  - Sign-up / onboarding
  - The live **6-step journey tracker** (Secure placement → MyIntealth → AMC →
    AHPRA → Visa → PBS & Medicare)
  - Job-match / secured-placement card
  - **RSO chat** / support thread
  - Document scan/upload
  - AHPRA tracker
- These are uploaded as Higgsfield reference media and shown on real phones/laptops
  held by the (generated) characters — **UI is genuine, the world is generated.**

### C. Location / world plates (Higgsfield `generate_image`, reused)

Golden-hour Australian coast · bright modern Aussie practice (interior +
exterior) · spacious sunny family home + garden · outdoor café / lifestyle ·
welcoming regional / outer-metro town main street · a grey UK-winter "before"
street · sunlit suburban Aussie street.

## The 10-video lineup

### 7 lifestyle ads — Facebook / Instagram paid
Format: **9:16 + 1:1**, 15–30s, hook in <2s, captions baked in, CTA end-card.
Style mix across the seven: 3 cinematic · 2 UGC · 2 day-in-life.

1. **"The 4pm Finish"** *(cinematic · Dr James)* — grey NHS 7pm still on shift →
   Aussie golden-hour beach after an early clinic finish.
   Hook: *"In the NHS, 4pm meant three more hours. Here it means the ocean."*
2. **"Room to Breathe"** *(cinematic · Dr Ruth + family)* — cramped UK flat →
   spacious sunny home, kids in the garden. Family pathway + permanent future.
3. **"Worth More Here"** *(cinematic · Dr Priya)* — a GP genuinely valued;
   modern practice, mixed billing, *"top GPs earn up to $1M."*
   (Also cut for LinkedIn.)
4. **"I left the NHS"** *(UGC · Dr Aisha)* — selfie-style:
   *"Six months ago, 12-hour days. Now I surf before clinic."*
5. **"Things nobody tells UK GPs about moving to Australia"** *(UGC · Dr Tom)* —
   punchy myth-buster (AHPRA's less scary than you think… and it's free with GP Link).
6. **"A Tuesday"** *(day-in-life · Dr Ben)* — morning coffee → relaxed clinic →
   afternoon with family. Calm, trust-building.
7. **"The Regional Draw"** *(day-in-life · Dr Emma)* — welcoming outer-metro town;
   *demand works in your favour*; community warmth.

### 3 app-ease videos

- **A — "The Whole Move, One App"** *(flagship hybrid · Dr Nadia + RSO Sarah)* —
  45–60s · 9:16 + 1:1 + 16:9. Moving to Australia with the app featured
  throughout: apply to a position → guided through the real 6-step journey on
  the phone → RSO Sarah supporting the whole way. Emotional + product. Runs
  everywhere (paid social, YouTube, site hero).
- **B — "GP Link — Australia, handled"** *(pure app commercial · Dr Chris + Sarah)* —
  ~30s · 9:16 + 1:1 + 16:9. Product hero: real UI, the 6 steps, smart checks
  that catch problems in minutes, live job match, RSO chat — all free for doctors.
- **C — "3 taps to Australia"** *(short app cut · Dr Leila)* — 15–20s · 9:16 + 1:1.
  Sign up in 2 min → we tell you the exact documents → track AHPRA/AMC live →
  accept your job in-app. Fast retargeting cut derived from B but standalone.

## Format & export matrix

| Video | 9:16 | 1:1 | 16:9 | Duration |
|-------|:----:|:---:|:----:|----------|
| 1–7 (lifestyle) | ✅ | ✅ | — | 15–30s |
| 3 (also LinkedIn) | ✅ | ✅ | ✅ | 15–30s |
| A (flagship) | ✅ | ✅ | ✅ | 45–60s |
| B (commercial) | ✅ | ✅ | ✅ | ~30s |
| C (short cut) | ✅ | ✅ | — | 15–20s |

## Reference-image shot list (Phase 2, Higgsfield `generate_image`)

- 10 GP character portrait sets (front + 3/4) — one per video.
- 1 RSO Sarah portrait set.
- Location plates: golden-hour beach · practice interior · practice exterior ·
  family home + garden · outdoor café · regional town main street · grey UK-winter
  street · sunlit suburban Aussie street.
- Brand frames: logo end-card, caption-style card.
- Real app screenshots uploaded via `media_upload` (not generated).

## Fable 5 handoff structure (Phase 3)

For each of the 10 videos, Fable 5 receives a brief packet and returns
per-shot `generate_video` prompts:

```
{
  video: <#/title>,
  style: cinematic | UGC | day-in-life | app-hybrid | app-commercial | app-short,
  formats: [9:16, 1:1, 16:9?],
  duration: <s>,
  gp_character_ref: <portrait asset id>,
  rso_ref: <Sarah asset id | none>,
  location_plates: [<asset ids>],
  app_assets: [<real screenshot asset ids>],
  beat_sheet: [ <hook>, <turn>, <payoff>, <CTA/end-card> ],
  vo_caption_direction: <tone + key lines from marketing copy>,
  cta: "Create your free account · free forever for doctors"
}
```

## Authenticity guardrail

Characters are AI-generated and **illustrative**, not real GP Link clients.
Where a video reads as a first-person personal testimonial (videos 4 and 5, the
UGC cuts), add a subtle on-screen **"Dramatisation"** note and never attach a
real person's name or a specific factual claim presented as verified. This keeps
the campaign honest for a regulated recruitment brand. *(Flagged for owner
sign-off at spec review.)*

## Open items for owner sign-off

1. Authenticity guardrail above — confirm the "Dramatisation" approach on the
   two UGC videos.
2. Character looks/names are illustrative — confirm or adjust the demographic mix.
3. Real app screenshots must be captured live before Phase 2.
