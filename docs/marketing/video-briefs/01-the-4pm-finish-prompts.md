# Video #1 "The 4pm Finish" — Higgsfield prompt set (v2, IN PRODUCTION)

**Status: owner approved ("go", 2026-07-13). Reference kit BUILT & QA'd;
shot generation under way.** Owner picked option 2 on the screenshot naming —
implemented harder: the greeting header is physically cropped off the
reference, so no name can ever render.

## Production asset registry (Higgsfield job/media IDs)

| Asset | ID | Notes |
|-------|----|----|
| Dr James anchor portrait (front) | job `3ef70a90-e91c-4096-a4b7-94c683ed3550` | warm take B face, neutralised via NBP edit |
| Dr James 3/4 portrait | job `3c608e73-4724-4fc2-83ab-18ea690ea00e` | identity holds |
| R3 NHS room plate (4K) | job `f4014d84-94e7-4887-b88d-71fd1d15a08d` | clock verified 7:00 |
| R4 practice plate | job `e001614d-ceb9-42e1-a07b-328fcc4a85aa` | had stray sign letters — superseded by F5 fixed |
| R5 beach plate | job `1d4191a3-adcf-47bd-b408-421b0e75d1f4` | |
| F1 S1 seed (desk slump) | job `952c53da-bcfb-4afb-b402-832583992f41` | clock 7:00, lanyard, light-blue shirt |
| F2c clock insert seed | media `f948b0d0-683f-4060-9084-6442537ccfb5` | PURE CROP of R3 (no gen risk) |
| F3 S3 seed FIXED | job `bf3eb517-ba59-4e3e-a874-d66984cf612c` | shirt continuity fixed (grey tee → light-blue) |
| F5 S5 seed FIXED | job `b12f66ad-854c-484a-b17a-cf7a5bc05dcd` | sign misspelling "CENITRE" corrected |
| F5b watch insert seed (4K) | job `b922072b-5500-45ac-a0be-26153722e548` | dial verified 4:00 |
| F6 S6 seed (beach walk) | job `d384faeb-b0a4-4ef8-937e-2bf08ab6e121` | |
| App screen CROPPED (S4) | media `44f29cf5-d11b-40ed-8aaa-c3bb6ac41378` | greeting header removed pre-upload |
| App screen original (unused) | media `1dd84e3d-388c-4ce7-9c8a-74424c5e0fbb` | shows "Dr Helen" — do not use in shots |
| S1 video take 1 | job `ec9cfd08-2140-440a-a1d2-2246744d81a0` | seedance_2_0 std 1080p 4s, audio off. **COMPLETED + frame-QA'd:** performance arc lands (rub → clock glance → sag, push-in mid→CU, clock pinned 7:00, grade right). Nit: lanyard print mirrors ("SHN") in final CU — passable as strap reverse, monitor in edit. **Awaiting owner calibration verdict before S2–S6 run.** |

**Costs (actual):** portrait 0.12 cr · NBP 2k plate 2 cr · Seedance 4s/1080p/std
36 cr. Balance at production start: 2,492.7 (Ultra).

**House-style learnings (carry to videos 2–10):**
1. soul_2 with a reference image may auto-"enhance" the prompt and override
   intent (asked neutral, got smile) AND drift identity — do identity-preserving
   edits with `nano_banana_pro` image-to-image instead.
2. Always verify generated signage/dials at full resolution — caught
   "MEDICAL CENITRE" and fixed via minimal NBP edit.
3. Bake times-of-day into seed stills; crop inserts from verified plates
   (zero-risk) rather than regenerating.
4. Seedance may suggest a preset; decline via `declined_preset_id` and keep the
   literal prompt.

---

## 1. Model plan

| Job | Model | Why | Key settings |
|-----|-------|-----|--------------|
| Video clips | **Seedance 2.0** (`seedance_2_0`) | Top `models_explore` recommendation: reference-driven video with identity-consistent `image_references` + `start_image` seeding — exactly our portrait + plate workflow. | `mode: std`, `resolution: 1080p`, `aspect_ratio: 9:16`, `generate_audio: false` (sound-off autoplay; VO added in edit if used), duration 4–8s per clip (model minimum is 4s; we trim in edit) |
| Character portraits | **Soul 2.0** (`soul_2`) | Higgsfield's photoreal character specialist (portrait/character tags), 2k quality. | `quality: 2k`, `aspect_ratio: 3:4` |
| Location plates + composed start frames | **Nano Banana Pro** (`nano_banana_pro`) | Photoreal, up to 4K, and reliably renders *legible text/dials* — critical because our motif is a readable clock (7:00 → 4:00). Accepts multiple reference images for compositing James into the plates. | `resolution: 2k` (4k for the two clock/watch frames), `aspect_ratio: 9:16` |
| Fallback video model | Kling v3.0 | If Seedance identity drift or motion disappoints on calibration takes. | — |

Workflow catalog checked: the only bundled workflow (`video-explainer`) is for
stylized animation, explicitly not photoreal ads — so we drive `generate_video`
directly, as the spec assumed.

**Credits:** balance is **2,492.7 (Ultra plan)**. Per-job cost gets confirmed on
the first generation before we commit to the full run.

**Finish:** picked takes get `upscale_video` to 4K; 1:1 deliverable via
`reframe` (or a center crop in edit) from the 9:16 master — everything is
composed center-safe.

---

## 2. Reference asset build (order matters)

### R0 — Real logo (upload, not generated)
`media_upload` → `media/images/GP Link Logo (BG removed) (1).png`. Used only in
the edit-built end-card (S7). We do **not** let a generator redraw the logo.

### R1 — Dr James portrait, front (soul_2, 2k, 3:4)
> Studio reference portrait, head and shoulders, of a 34-year-old white British
> man: lean athletic build, short mid-brown hair neatly cut, light stubble, a
> kind, approachable face carrying the faint tiredness of a working doctor
> around the eyes. Neutral expression with a hint of warmth, looking straight
> into the lens. Plain mid-grey seamless studio background, soft even diffused
> key light, no harsh shadows. He wears a plain light-blue shirt, no logos.
> Ultra-photorealistic photography, 85mm portrait lens, sharp focus on the
> eyes, true-to-life skin texture with visible pores and faint lines,
> individual hair strands, natural teeth. No retouching, no beauty-filter
> smoothing, no waxy skin.

### R2 — Dr James portrait, 3/4 (soul_2, 2k, 3:4, media: R1)
> The same man as the reference image, identical face, hair and light-blue
> shirt, now turned three-quarters to camera, eyes to lens, same mid-grey
> studio background and soft diffused light. Ultra-photorealistic, 85mm lens,
> sharp on the eyes, true-to-life skin texture, no retouching.

### R3 — UK "before" plate (nano_banana_pro, 4k, 9:16)
> Empty NHS GP consulting room at night in the United Kingdom, no people.
> A cluttered desk with tall stacks of patient files and letters, an ageing
> desktop computer, an NHS lanyard lying on the desk, a half-drunk mug of tea.
> Harsh fluorescent ceiling light, cold desaturated blue-grey colour cast,
> cramped oppressive framing. On the wall a plain institutional clock clearly
> reading exactly 7:00, both hands crisp and legible. Behind the desk a window
> streaked with rain; outside, a dark wet British street under an amber
> streetlight. Ultra-photorealistic documentary interior photograph, vertical
> 9:16, natural lens character, subtle grain.

### R4 — Aussie practice exterior plate (nano_banana_pro, 2k, 9:16)
> Bright modern Australian general practice medical centre, exterior entrance
> in mid-afternoon sunshine, no people. Clean timber-and-white facade, large
> glass entry doors, generic "Medical Centre" signage with no real brand
> names, native greenery, deep blue sky. Welcoming, open, luminous.
> Ultra-photorealistic architectural photograph, vertical 9:16, warm natural
> light, gentle long shadows.

### R5 — Golden-hour beach plate (nano_banana_pro, 2k, 9:16)
> Wide Australian coastline at golden hour, no people. A long clean beach with
> gentle rolling surf catching low warm sunlight, a sandy path through native
> dune grass in the foreground leading down to the water, sky in warm golds
> and soft pinks, ocean glittering to the horizon. Vast, open, free.
> Ultra-photorealistic landscape photograph, vertical 9:16, warm cinematic
> golden grade, natural lens flare.

### Composed start frames (nano_banana_pro, image-to-image, 9:16)
Seeding each people-shot from a *composed still* keeps the world and the face
locked before motion is added.

**F1 — Shot 1 seed** *(medias: R1 + R3)*
> Place the man from the first reference image into the NHS consulting room
> from the second reference image, keeping his face exactly identical: he sits
> slumped at the cluttered desk in a rumpled light-blue shirt with an NHS
> lanyard, elbows on the desk, one hand raised to his eyes mid eye-rub, files
> stacked around him, the wall clock above reading exactly 7:00, rain-streaked
> dark window behind. Cold fluorescent blue-grey grade, cramped mid-shot
> framing him slightly low in the vertical frame. Ultra-photorealistic.

**F2c — Clock macro seed** *(medias: R3)* — 4k
> Close-up of the plain institutional wall clock from the reference room,
> centered in the upper third of a vertical 9:16 frame, dial clearly and
> legibly reading exactly 7:00, pale wall behind, cold fluorescent light,
> subtle shadows. Ultra-photorealistic macro photograph.

**F3 — Shot 3 seed** *(medias: R1 + R3)*
> The same man in the same NHS room, seen from slightly behind and over his
> shoulder: his hand rests on a laptop lid he is about to close; beside the
> laptop a phone lies on the desk, its screen glowing with a warm golden
> coastal horizon, the warm light spilling onto his face and hand amid the
> cold blue-grey room. His face is in profile, weary but caught by the glow.
> Ultra-photorealistic, cold room / warm phone-light contrast.

**F5 — Shot 5 seed** *(medias: R1 + R4)*
> The man from the first reference image, face exactly identical, now rested
> and healthy, in a crisp smart-casual shirt with sleeves rolled, mid-stride
> pushing open the glass entry door of the Australian medical practice from
> the second reference image, stepping out into full afternoon sunshine, a
> classic wristwatch on his left wrist. Warm golden grade, open vertical
> framing, him center-frame. Ultra-photorealistic.

**F5b — Watch macro seed** *(no refs)* — 4k
> Macro photograph of a classic men's wristwatch on a man's wrist in warm
> golden afternoon sunlight, the dial centered in the upper third of a
> vertical 9:16 frame and clearly, legibly reading exactly 4:00, light
> glinting off the glass, shallow depth of field, real skin texture and fine
> arm hair. Ultra-photorealistic.

**F6 — Shot 6 seed** *(medias: R1 + R5)*
> The man from the first reference image, seen from behind in three-quarter
> back view so a sliver of his identical face shows, wearing a relaxed tee
> with a small towel over one shoulder, walking down the sandy dune-grass
> path from the second reference image toward the glittering golden-hour
> ocean. Warm cinematic golden grade, vast open vertical framing.
> Ultra-photorealistic.

### App screenshot for Shot 4 — ✅ RESOLVED (owner-supplied, uploaded)
Real screenshot of the app home/journey screen ("Your Journey" progress card,
"Find Your Practice / Browse jobs", "The Journey" with Secure Placement
CURRENT) supplied by the owner from `IMG_0112.jpg` and uploaded via
`media_upload` → **`media_id: 1dd84e3d-388c-4ce7-9c8a-74424c5e0fbb`**
(`gp-link-app-home-journey.jpg`). Shot 4 runs **Plan A** with this reference.

⚠️ **Naming note for review:** the screenshot greets **"Welcome Back, Dr
Helen"** — a real client's first name — and S4 is a close-up where the screen
is legible. Options: (a) use as-is; (b) recapture the same screen from a demo
account named **Dr James** (matches the ad's character — cleanest); (c) keep
this capture but frame/flare S4 so the greeting line sits off-screen while the
journey card stays readable. Recommendation: **(b)**, else (c).

---

## 3. Shot prompts (`generate_video`, seedance_2_0)

Common params unless noted: `mode: std`, `resolution: 1080p`,
`aspect_ratio: 9:16`, `generate_audio: false`.

Every prompt ends with this shared block (written out in full when running):

> **[REALISM]** Ultra-photorealistic, shot on a digital cinema camera, shallow
> depth of field, subtle filmic grain, true-to-life skin with visible pores,
> realistic hair and hands. He breathes visibly, blinks naturally and
> irregularly, his gaze shifts and refocuses, micro-expressions keep the face
> alive — never a frozen stare. Avoid: waxy or plastic skin, a locked
> unblinking expression, morphing or warping faces or hands, extra or fused
> fingers, glassy uncanny eyes, teeth artifacts, flicker, CGI sheen,
> over-saturation, robotic camera glide.

### S1 — HOOK (beat 0–3s · generate 4s, trim)
`start_image: F1` · `image_references: R1, R2`
Caption: **"In the NHS, 4pm meant three more hours."**
> Night interior, cramped NHS consulting room under harsh fluorescent light,
> cold desaturated blue-grey grade. A 34-year-old British male GP — exactly
> the man in the reference images — sits slumped at a cluttered desk stacked
> with patient files, rumpled light-blue shirt, NHS lanyard. Above him a wall
> clock reads 7:00 and stays fixed at 7:00; behind him, rain streaks the dark
> window. He rubs his eyes slowly with thumb and forefinger, takes a heavy
> slow blink, his gaze drifts up to the wall clock then falls back to the
> files, brow tightening, a weary exhale through the nose, shoulders sagging;
> he keeps breathing, small involuntary head shifts. Camera: one slow, steady
> push-in from mid-shot toward his face with a breath of handheld
> imperfection. [REALISM]

### S2a — Tired eyes (beat 3–6s · generate 4s, use ~1.2s)
`image_references: R1`
Caption: *(hold S1 caption)*
> Extreme close-up of the same man's tired eyes under cold fluorescent light:
> reddened, heavy-lidded, faint dark circles, skin pores and fine lines fully
> visible. One slow heavy blink, then a small flick of the gaze to the side
> and back to nothing, brow micro-tension, the glisten of fatigue. Camera
> nearly static with a breath of drift. Cold clinical blue-grey grade.
> [REALISM]

### S2b — Rain on glass (use ~1s)
`start_image:` crop of R3 window region
> Interior close-up at night: rain droplets running slowly down a window
> pane, an amber streetlight blooming out of focus in the dark street beyond;
> in the near foreground bokeh, a tall stack of patient files at the desk
> edge. Slow rack focus from the rain to the files. Cold blue-grey grade,
> quiet and oppressive. [REALISM]

### S2c — The clock, A-side of the time rhyme (use ~1s)
`start_image: F2c`
> Locked-off close-up of a plain institutional wall clock on a pale wall
> under fluorescent light, dial sharp and legible at 7:00, the red second
> hand ticking steadily — the only movement in frame — with a faint
> fluorescent flicker. Cold blue-grey grade, subtle grain. The hour and
> minute hands stay fixed at 7:00. [REALISM]

*Edit note: S2c's dial position/scale deliberately matches S5b's watch dial —
the 7:00 → 4:00 time rhyme the film hangs on.*

### S3 — THE TURN (beat 6–10s · generate 4s)
`start_image: F3` · `image_references: R1, R2`
Caption: **"You didn't train ten years to burn out."**
> Same cold NHS room, seen over the man's shoulder. He closes the laptop lid
> with one decisive movement of his hand; beside it a phone glows with a warm
> golden coastal horizon, and the warm light spills across his face and chest
> amid the cold blue-grey room. His eyes widen a touch, an intake of breath,
> a blink, then his gaze locks onto the warm glow as the tension visibly
> leaves his jaw — the first flicker of hope. Camera: slow push past his
> shoulder toward the glowing phone; in the final moments the warm light
> gently blooms and rises to fill the frame. [REALISM]

*Transition: that closing light-bloom is the grey→gold wipe into S4.*

### S4 — BRIDGE, brand touch (beat 10–14s · generate 4s)
Caption: **"Move to Australia. GP Link handles every step — free."**

**Plan A (locked — real screenshot uploaded)** — `image_references:`
`1dd84e3d-388c-4ce7-9c8a-74424c5e0fbb` (app home/journey screen)
> Close-up of two hands holding a phone in bright warm morning light beside a
> large window, sun flare gently sweeping across the frame. On the phone
> screen: the GP Link app exactly as in the attached reference screenshot —
> interface crisp, legible and undistorted, treated like a real filmed
> screen. The thumb taps once, gently; the screen stays steady and true to
> the reference. Warm, hopeful grade, shallow depth of field, photoreal hands
> with correct fingers. [REALISM]

**Plan B (no screenshot yet)**
> Close-up of two hands holding a phone in bright warm morning light beside a
> large window, strong sun flare washing across the glass so the screen reads
> as a bright warm glow rather than legible UI. The thumb taps once,
> confidently; the man's face is softly out of focus behind the phone, the
> beginnings of a faint smile. Warm, hopeful grade, shallow depth of field,
> photoreal hands with correct fingers. [REALISM]

### S5 — ARRIVAL (beat 14–18s · generate 5s, trim)
`start_image: F5` · `image_references: R1, R2`
Caption: **"Now 4pm means 4pm."**
> Full afternoon sunshine. The same man — rested now, in a crisp smart-casual
> shirt with sleeves rolled — pushes open the glass door of a bright, modern
> Australian medical practice and walks out into the sun. He squints happily
> into the light as a genuine easy smile forms (never held frozen), glances
> down at his wristwatch, gives a small nod to himself, blinks naturally,
> shoulders loose, stride easy with real weight. Camera: a gentle gliding
> pull-back ahead of him at chest height, warm golden grade, open vertical
> framing, soft long shadows. [REALISM]

### S5b — The watch, B-side of the time rhyme (use ~1s, cut inside beat 5)
`start_image: F5b`
> Macro close-up in warm golden sunlight: a man's wrist lifts a classic
> wristwatch into frame, the dial sharp and legible at 4:00, light glinting
> across the glass as it settles, shallow depth of field, real skin texture.
> The hands stay fixed at 4:00. [REALISM]

### S6 — PAYOFF (beat 18–25s · generate 8s, trim to ~7s)
`start_image: F6` · `image_references: R1, R2` · `duration: 8`
Caption: **"Here, 4pm means the ocean."**
> Golden hour on a wide Australian beach. The same man, in a relaxed tee with
> a small towel over one shoulder, walks down the sandy path through the dune
> grass toward the glittering water. A deep exhale and his shoulders visibly
> drop; an unguarded smile builds as he watches the horizon, hair moving in
> the sea breeze, he blinks against the wind, easy loping stride with real
> weight and momentum. Waves roll in with natural physics. Camera: a gentle
> rising follow from behind, drifting slightly sideways to open up the
> coastline, long-lens flare kissing the frame. Warm golden cinematic grade.
> [REALISM]

### S7 — END-CARD (beat 25–28s · built in edit, no generation)
Real uploaded logo (R0) on clean white resolving to brand blue `#2563eb`,
chain mark accent.
Captions: **"Your career upgrade is also a life upgrade."** then
**"Create your free account — free forever for doctors."**
Rationale: compositing the genuine logo in the edit costs nothing and
guarantees zero warp on the one asset that must never look "AI".

---

## 4. Assembly notes

- **Timeline (~28s):** S1 3.0 → S2a/b/c ≈1s each → S3 4.0 → S4 4.0 →
  S5 3.0 + S5b 1.0 → S6 7.0 → S7 3.0.
- **Captions:** brand blue `#2563eb`, bold, high-contrast, baked in,
  positioned inside the 9:16 *and* 1:1 safe zone (center band).
- **Grades:** UK clips cold blue-grey; AU clips warm golden — the lift is the
  grade shift. Keep the S3→S4 light-bloom as the only "effect".
- **Exports:** 9:16 master → 1:1 via `reframe`/center crop. Picked takes →
  `upscale_video` 4K before final grade.
- **VO (optional):** brief's warm British male VO; if used, thin the captions
  to key phrases.

## 5. Review checklist for the owner

1. Model plan OK (Seedance 2.0 / Soul 2.0 / Nano Banana Pro)?
2. Dr James portrait prompt — happy with the look?
3. Clock strategy: time baked into seed stills (F2c 7:00 / F5b 4:00), hands
   pinned in the prompts, dedicated rhymed inserts. OK?
4. Shot 4: screenshot supplied & uploaded (Plan A locked). Decide the
   "Dr Helen" naming question above — as-is / recapture as Dr James /
   frame the greeting off-screen.
5. End-card built in edit from the real logo (no generated logo). OK?
6. Any caption copy changes before we generate?

**Next step after sign-off:** build R1→R5 + F-frames, review the stills, then
generate S1 first (the calibration shot), review, and roll through the list.
