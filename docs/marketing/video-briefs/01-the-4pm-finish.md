# Video #1 Brief Packet — "The 4pm Finish"

**Ready-to-run brief for Claude Fable 5.** Fable turns this into the exact
per-shot Higgsfield `generate_video` prompts, we review, refine, generate.
Parent spec: `docs/superpowers/specs/2026-07-13-uk-gp-marketing-video-campaign-design.md`.

---

## Snapshot

| | |
|---|---|
| Title | **The 4pm Finish** |
| # / batch | Video 1 of 10 · **first calibration video** (locks the cinematic grade + character/location look) |
| Style | Cinematic lifestyle |
| GP character | Dr James Fletcher (this video only) |
| RSO | none |
| Placement | Facebook / Instagram paid |
| Formats | **9:16** (primary) + **1:1** (center-safe crop) |
| Duration | **≤30s** (target ~28s) |
| Playback | sound-off autoplay → **captions baked in**; VO optional |
| CTA | Create your free account · free forever for doctors |

## Creative intent (the spine)

A **before → after** contrast. The grey, never-ending NHS shift on one side;
sunshine, an early finish and the ocean on the other — with GP Link as the free
bridge across. The whole film hangs on one motif: **the clock.** In the NHS,
4pm means three more hours. In Australia, 4pm means the beach. We hard-cut the
same time reading from a grim night-shift clock to a relaxed afternoon watch.

Voice is **second person / universal**, not a personal testimonial — so we stay
honest (Dr James is an AI character, not a real client) and the ad speaks to the
viewer directly.

## Character brief — Dr James Fletcher (for the portrait reference)

- UK GP, **34**, white British, lean/athletic build, short mid-brown hair, light
  stubble, warm and approachable, quietly tired at the start.
- **NHS wardrobe:** rumpled light-blue shirt or scrubs, NHS lanyard/ID, under
  cold fluorescent light.
- **Australia wardrobe:** crisp smart-casual shirt (sleeves rolled) leaving the
  practice → relaxed tee with a towel/boardshorts feel at the beach.
- Generate one portrait reference set (front + 3/4, soft neutral light) and reuse
  it across every shot for face consistency (Higgsfield character reference).

## Assets to prepare first

**Generate (Higgsfield `generate_image`) — brief, not final prompt:**
1. **Dr James portrait set** — the character anchor (above).
2. **UK "before" plate** — cold, grey, rain-streaked: a fluorescent NHS
   corridor / consulting room at night, window showing dark wet street. Blue-grey,
   clinical, oppressive.
3. **Aussie practice plate** — a bright, modern Australian GP practice, clean
   timber-and-white, big windows, sunlight; friendly exterior with signage feel.
4. **Golden-hour beach plate** — wide Australian coastline at sunset, warm light,
   gentle surf, open and free.

**Upload (real asset, `media_upload`):**
- GP Link logo (`media/images/GP Link Logo (BG removed) (1).png`) → end-card.

## Shot list / beat sheet (~28s)

| # | Time | Frame | Grade | Caption (on-screen) |
|---|------|-------|-------|---------------------|
| 1 | 0–3s | **HOOK.** Dr James at a cluttered NHS desk, night outside, wall clock reads **7:00**. Slumped, rubbing eyes. Slow push-in. | Cold blue-grey | "In the NHS, 4pm meant three more hours." |
| 2 | 3–6s | Detail beats — tired eyes, rain on glass, a stack of unfinished files, the clock ticking. | Cold blue-grey | *(hold)* |
| 3 | 6–10s | **THE TURN.** He closes the laptop; on a phone screen a warm light / horizon appears. The grey is about to break. | Grey → warming | "You didn't train ten years to burn out." |
| 4 | 10–14s | **BRIDGE (brand, light touch).** Quick, elegant: GP Link's role — a phone/app moment, sun spilling in. | Warm | "Move to Australia. GP Link handles every step — free." |
| 5 | 14–18s | **ARRIVAL.** Dr James walks out of the bright modern Aussie practice into sunshine; glances at his watch — it reads **4:00**. Relaxed, lighter. | Warm golden | "Now 4pm means 4pm." |
| 6 | 18–25s | **PAYOFF.** Coastal path → golden-hour beach; he walks toward the water, exhales, ocean glittering. | Warm golden, cinematic | "Here, 4pm means the ocean." |
| 7 | 25–28s | **END-CARD.** GP Link logo on clean white/brand-blue; chain mark. | Brand | "Your career upgrade is also a life upgrade. · Create your free account — free forever for doctors." |

## Performance & realism (per shot)

**Follow the campaign-wide Realism & performance standard in the spec** —
ultra-realistic people and scenery, and a *living* face (natural blinking,
gaze shifts, micro-expressions, breathing) in every shot, never one frozen look.
Dr James carries a visible emotional arc across the film — exhausted → a flicker
of hope → free. Concretely:

- **Shot 1:** heavy, slow blink; a tired eye-rub; gaze drifts up to the clock
  then down; brow tension; a weary exhale through the nose.
- **Shot 2:** on the eye/detail close-ups — reddened tired eyes, one slow blink,
  a small flick of the gaze; subtle.
- **Shot 3:** the first lift — eyes widen a touch, an intake of breath, a blink,
  then focus toward the warm light; tension starts leaving the jaw.
- **Shot 4:** if in frame — the face softens, the beginnings of a faint smile.
- **Shot 5:** relief — squints into the sun, a genuine easy smile *forming*
  (not held), a glance at the watch, a small nod to himself, a natural blink.
- **Shot 6:** freedom — a deep exhale, shoulders drop, an unguarded smile that
  *builds*, eyes on the horizon, hair moving in the breeze, blinks against the wind.

Write these performance cues explicitly into each shot's `generate_video` prompt,
and upscale to 2K/4K so skin and eyes read real.

## Optional voiceover (warm male, British accent)

> "In the NHS, four o'clock meant three more hours. You didn't train ten years to
> burn out. So thousands of GPs are moving to Australia — and GP Link handles
> every step, for free. Now four o'clock means the ocean. GP Link — your move,
> handled."

*(If VO is used, trim captions to short key phrases so they don't compete.)*

## Look, motion & transitions

- **Two grades, one motif.** UK = cold, desaturated blue-grey, tight/cramped
  framing, fluorescent. Australia = warm golden-hour, open wide framing, natural
  light. The emotional lift *is* the grade shift.
- **Signature transition:** a **match cut on the clock/time** between shot 2→5
  (7:00 grim → 4:00 relaxed) and a light-bloom wipe from grey to gold at 3→4.
- **Camera:** slow push-ins on the NHS side (claustrophobic); gentle gliding/
  hand-of-god follow on the Australia side (freedom).
- **Brand:** stays subtle until the end-card — one clean app/phone beat at shot 4,
  full logo lockup only at shot 7. Captions in brand blue `#2563eb`, bold,
  high-contrast, positioned in the 9:16/1:1 safe zone.

## Format & export

- Compose for **9:16**; keep action/captions center-safe so a **1:1** crop works.
- Target **~28s** (hard cap 30s). Per-clip generation ~3–5s each, assembled to the
  beat sheet.

## Higgsfield production notes

- **Face consistency:** attach the Dr James portrait as the character reference on
  every shot he appears in (shots 1, 3, 5, 6).
- **Controlled look:** prefer **image-to-video seeded from the location plates**
  (plates 2/3/4) so the world matches across shots rather than drifting.
- **Model choice:** run `models_explore(action:'recommend')` with the goal
  "cinematic image-to-video, character-consistent, golden-hour vs cold-clinical"
  before locking a model — don't assume; pick what it recommends.
- Generate each shot as its own clip, review, then assemble + grade + captions +
  logo end-card in the edit.

## What Fable returns for this video

Per shot (1–7): a final `generate_video` prompt containing subject + action +
camera move + lighting/grade + the referenced character/plate + duration, plus
the caption text and transition note. That set is what we review and refine
before generating.

## Guardrails

- **Original, not derivative** — our own voice; no competitor creative referenced.
- **Honest** — second-person/universal copy; Dr James is **not** presented as a
  named real client, so no "Dramatisation" label is required here (unlike the UGC
  videos #4/#5).
- All claims stay within GP Link's real marketing ("every step handled", "free
  for doctors") — no invented figures in this cut.
