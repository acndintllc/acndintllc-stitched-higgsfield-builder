# BUILD MANIFEST — stitched-higgsfield-builder

**Phase:** Mason complete for C1–C7. C8 (UI wiring) outstanding.
**Status:** 112 tests passing across 7 chunks. Concat path verified end-to-end against real ffmpeg.
**Date:** 2026-09-14
**Architecture:** GPU-first (Wan2GP only) + internal voice/captions

### Verification (run, not assumed)

| Check | Result |
|---|---|
| `npm test` (packages/studio) | ✅ 7 suites, 112 tests passing |
| Real-ffmpeg smoke: 8×60s clips → concat → mux | ✅ `final.mp4` @ 480.000s |
| Final mp4 streams | ✅ h264 video 480.0s + aac audio 480.0s (in sync) |
| Sidecar captions | ✅ `captions.srt`, 00:00:00,000 → 00:08:00,000, zero gaps |
| Resume after failure at clip K | ✅ re-run regenerates only clips K…7 |

The smoke test stubs only the GPU/network-bound chunks (Claude, LoRA, TTS);
ffmpeg, ffprobe and caption generation run for real. Every Wan2GP endpoint
path remains unvalidated against a live server — see B3.

---

## RECON FINDINGS (verified, not assumed)

| Check | Result |
|---|---|
| All 5 source repos reachable | ✅ verified via `git ls-remote` |
| Base repo cloned | ✅ `/home/user/stitched-higgsfield-builder` |
| `npm install` | ✅ clean |
| Dev server | ✅ Ready in 1815ms |
| `/studio` route | ✅ HTTP 200, 14138b |
| `ffmpeg` present | ✅ installed (7:6.1.1-3ubuntu5, libass) |
| Wan2GP port 7860 (SSH tunnel) | ℹ️ Will be bound at runtime via rented GPU |
| Muapi 18s cap | ✅ Confirmed; incompatible with 8min goal |

### Architecture decision

**Shifted from Muapi-centric to GPU-first (Wan2GP):**
- Muapi max 18s clips → 27–96 per 8-minute video (exploding cost)
- Wan2GP sliding windows → no duration cap (1+ minute per clip)
- LoRA character lock → stable identity across all clips (better than reference-image fade)
- Internal voice + captions → no post-production (11 Labs + CapCut eliminated)
- Hourly GPU cost → flat (better economics for publishing)

---

## CHUNKS (8 buildable, parallel candidates marked)

### C1 — Engine Abstraction (PARALLEL) — ✅ BUILT
- **Path:** `packages/studio/src/engines/{index,wan2gp}.js`
- **Responsibility:** One interface over the Wan2GP queue.
- **Interface:** `generate({prompt, firstFrame, soulId, voiceId}) => {video, lastFrame, audioPath}`
- **Inputs:** prompt string, firstFrame path/URL|null, soulId string, voiceId string
- **Outputs:** `{video, lastFrame, audioPath}` (video is raw file, audio is .wav or .m4a)
- **Spec reqs:** `http://127.0.0.1:7860` (Wan2GP via SSH tunnel); submit → poll → complete
- **Eval:** queue polling submits then polls to completion; documented output shape returned; job failure, missing job_id, missing video and missing frame data all surface as errors
- **Muapi removed (CEO decision):** the 18s clip cap forces 27–96 clips per 8-minute video. The rented-GPU model replaces it outright, so the dual-backend ENV switch and `muapi-fallback.js` were dropped. The upstream app's own `src/muapi.js` is untouched.
- **Tests:** 12 passing

### C2 — Character Lock via LoRA (PARALLEL) — ✅ BUILT
- **Path:** `packages/studio/src/builder/character-lock.js`
- **Responsibility:** 3–5 character reference images → LoRA weights (.safetensors) → stable `soulId`.
- **Spec reqs:** Train LoRA on Wan2GP using reference images; store .safetensors to disk; return soulId hash (deterministic, same images = same hash)
- **Eval:** same 5 images → same soulId; LoRA weights are byte-identical on re-train; soulId present on all 8 generation calls; character identity stable across all clips
- **Depends on:** Wan2GP LoRA training endpoint; GPU rental active
- **Tests:** 15 passing

### C3 — Scene Lock via Sliding Windows (PARALLEL) — ✅ BUILT
- **Path:** `packages/studio/src/builder/scene-lock.js`
- **Responsibility:** Extract multi-frame overlap data from Wan2GP API; pass to next generation for continuity.
- **Spec reqs:** Wan2GP sliding windows (multi-frame overlap, not single FLF2V); lastFrame array (5–10 frames) → firstFrame input for clip N+1
- **Eval:** clip N+1 first 5 frames are visually continuous with clip N last 5 frames; chain holds across all 8; zero jitter/seams
- **Depends on:** Wan2GP sliding-window support (native)
- **Tests:** 20 passing

### C4 — Claude Orchestration (PARALLEL) — ✅ BUILT
- **Path:** `packages/studio/src/lib/claude.js`
- **Responsibility:** Story → JSON array of exactly 8 prompts + voice direction + scene continuity tags.
- **Spec reqs:** prompts include `<character>`, `<scene>`, `<voice_direction>` tags; exactly 8; valid JSON; retry on malformed output
- **Eval:** returns exactly 8; valid JSON; each carries all 3 tags; sample output passes validation; malformed output is caught and retried
- **Fallback:** Qwen via `QWEN_API_KEY` if Claude fails
- **Tests:** 18 passing

### C5 — Voice Cloning & Synthesis (PARALLEL) — ✅ BUILT
- **Path:** `packages/studio/src/builder/voice-lock.js`
- **Responsibility:** Reference voice audio (5–30s) → voice embedding; TTS prompts across 8 clips → .wav files.
- **Spec reqs:** Wan2GP voice cloning (Ref2VA or equivalent); Qwen3 TTS or MiniMax H3 for synthesis; 1 voice per character; output .wav files named by clip
- **Eval:** voice embedding is deterministic (same reference audio = same embedding); synthesized audio is 60–65s per clip (matches video duration); audio is lossless or near-lossless
- **Depends on:** Wan2GP voice cloning + TTS endpoints; reference voice audio provided at C5 invocation
- **Tests:** 20 passing

### C6 — Caption Generation (PARALLEL) — ✅ BUILT
- **Path:** `packages/studio/src/builder/captions.js`
- **Responsibility:** Claude prompts → SRT subtitle file with timing.
- **Spec reqs:** Parse prompts; generate 3–5 captions per clip (~12s per caption); output valid .srt file with timecodes; captions match prompt intent
- **Eval:** SRT parses without error; timecodes are sequential and non-overlapping; captions are readable (40–60 chars); coverage = 100% of video runtime
- **Depends on:** C4 (Claude prompts)
- **Tests:** 12 passing

### C7 — 8-Pass Engine + Concat (SERIAL, depends on C1–C6) — ✅ BUILT
- **Path:** `packages/studio/src/builder/8pass.js`
- **Responsibility:** Orchestrate C1–C6 into full loop: 8x (video + audio + caption) → concat into single 8-min mp4.
- **Spec reqs:** queue-driven (poll Wan2GP queue, do not block); resumable (persist queue state); concat video + audio + captions via ffmpeg; final output ≈ 480–495s (8–8.25 min)
- **Eval:** all 8 clips produced in order; clip N+1 first frame continuous with clip N last frame; audio synced to video; captions burned or sidecar .srt; final mp4 plays end-to-end; failure at clip K logs K and does not truncate
- **Depends on:** C1, C2, C3, C4, C5, C6; ffmpeg; Wan2GP queue persistence
- **Tests:** 15 passing

### C8 — UI Wiring (SERIAL, depends on C1–C7) — ⬜ NOT STARTED
- **Path:** `app/studio/` + `packages/studio/src/components/`
- **Responsibility:** Soul ID upload → reference voice upload → story input → Generate → progress `N/8` → preview mp4.
- **Spec reqs:** upload 3–5 character images + reference voice audio; input story (100+ words); Generate button queues C7; progress bar reads real queue state (not timer); preview plays final mp4
- **Eval:** upload accepts both image + audio; Generate triggers C7 queue; progress advances 1/8…8/8 against queue state; preview loads and plays final mp4 without error

---

## BUILD ORDER

```
C1 ──┐
C2 ──┤
C3 ──┼─> C7 ──> C8
C4 ──┤
C5 ──┤
C6 ──┘
```
**Phase 1 (Parallel):** C1–C6 are independent and can be built in parallel.
**Phase 2 (Serial):** C7 integrates all; C8 wires UI to final output.
**Dependency note:** C6 depends on C4 (needs prompts to caption from). All others are truly independent.

---

## OPEN QUESTIONS (does not block, informational only)

1. **C2 — LoRA training time on Wan2GP.** Estimate: 5–15 min per character on RTX 4090. Actual depends on GPU SKU.
   Reference images can be pre-generated or provided by user (if synthetic character, use diffusion to generate 5 consistent frames).

2. **C5 — Voice reference audio length.** How long is acceptable for voice cloning? 
   Recommend: 10–30s of clean reference audio. Can be extracted from prior YouTube videos or generated TTS.

3. **C7 — Queue persistence across restarts.** Should 8-pass pipeline resume from a failed clip K?
   Design: store queue state in local SQLite (one record per clip: soulId, prompt, status, video_path, audio_path).
   Restore on re-invocation (skip clips 1…K-1, restart from K).

4. **Acceptance says "runs on Windows."** This container is Linux. Windows verification deferred to ThinkCentre.
   Code will be Windows-compatible (no POSIX-only paths/shell), but runtime test on actual Windows required.

---

## BLOCKERS (CEO decision required for ACCEPTANCE, not build)

| # | Blocker | Status | Impact |
|---|---|---|---|
| B1 | Git remote: `acndintllc/stitched-higgsfield-builder`. | ✅ RESOLVED — repo created by CEO. | Work pushed. |
| B2 | `ANTHROPIC_API_KEY` not set. | User has key (confirmed). | C4 (Claude orchestration) buildable + mock-testable; real 8 prompts require activation. |
| B3 | GPU rental: Wan2GP instance not provisioned. | User must rent GPU + SSH tunnel. | C1, C2, C5, C7 require active Wan2GP at `http://127.0.0.1:7860`. Mock testing possible; real clips require GPU. |
| B4 | Reference voice audio not provided. | User to provide or generate via TTS. | C5 (voice cloning) requires 10–30s audio sample. Can use silence placeholder for mock test. |
| B5 | Windows verification impossible in Linux container. | Informational only. | Code will be Windows-compatible. Final acceptance test must run on ThinkCentre. |

---

## APPROVED FOR BUILD (CEO confirmed)

✅ C1–C8 as specified  
✅ Internal voice + captions (no 11 Labs, no CapCut post-production)  
✅ GPU-first architecture (Wan2GP only — Muapi dropped per CEO decision)  
✅ LoRA-based character lock (stable identity across 8 clips)  

## NOT IN SPEC — will not be built without approval

- Auth, user accounts, persistence beyond queue state (resumable build)
- Cost tracking / rate limiting
- Deployment/CI
- Advanced analytics or telemetry
- Tests beyond the evaluation criteria specified per chunk
- Multi-character support (single synthetic character only)
- Audio/video post-processing (color correction, audio mixing, etc.)
- Discord/Slack integration or webhooks
