# BUILD MANIFEST — stitched-higgsfield-builder

**Phase:** Architect (spec broken into chunks)
**Status:** Approved by CEO. Ready for Mason phase.
**Date:** 2026-09-13
**Architecture:** GPU-first (Wan2GP primary) + internal voice/captions

---

## RECON FINDINGS (verified, not assumed)

| Check | Result |
|---|---|
| All 5 source repos reachable | ✅ verified via `git ls-remote` |
| Base repo cloned | ✅ `/home/user/stitched-higgsfield-builder` |
| `npm install` | ✅ clean |
| Dev server | ✅ Ready in 1815ms |
| `/studio` route | ✅ HTTP 200, 14138b |
| `ffmpeg` present | ❌ NOT INSTALLED (required for concat) |
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

### C1 — Engine Abstraction (PARALLEL)
- **Path:** `packages/studio/src/engines/{index,wan2gp,muapi-fallback}.js`
- **Responsibility:** One interface, two backends, switched by ENV.
- **Interface:** `generate({prompt, firstFrame, soulId, voiceId}) => {video, lastFrame, audioPath}`
- **Inputs:** prompt string, firstFrame path/URL|null, soulId string, voiceId string
- **Outputs:** `{video, lastFrame, audioPath}` (video is raw file, audio is .wav or .m4a)
- **Spec reqs:** primary → `http://127.0.0.1:7860` (Wan2GP via SSH tunnel); fallback → Muapi; ENV switch
- **Eval:** single test suite passes against both backends; switching ENV_ENGINE changes backend with zero call-site changes; queue polling works on both

### C2 — Character Lock via LoRA (PARALLEL)
- **Path:** `packages/studio/src/builder/character-lock.js`
- **Responsibility:** 3–5 character reference images → LoRA weights (.safetensors) → stable `soulId`.
- **Spec reqs:** Train LoRA on Wan2GP using reference images; store .safetensors to disk; return soulId hash (deterministic, same images = same hash)
- **Eval:** same 5 images → same soulId; LoRA weights are byte-identical on re-train; soulId present on all 8 generation calls; character identity stable across all clips
- **Depends on:** Wan2GP LoRA training endpoint; GPU rental active

### C3 — Scene Lock via Sliding Windows (PARALLEL)
- **Path:** `packages/studio/src/builder/scene-lock.js`
- **Responsibility:** Extract multi-frame overlap data from Wan2GP API; pass to next generation for continuity.
- **Spec reqs:** Wan2GP sliding windows (multi-frame overlap, not single FLF2V); lastFrame array (5–10 frames) → firstFrame input for clip N+1
- **Eval:** clip N+1 first 5 frames are visually continuous with clip N last 5 frames; chain holds across all 8; zero jitter/seams
- **Depends on:** Wan2GP sliding-window support (native)

### C4 — Claude Orchestration (PARALLEL)
- **Path:** `packages/studio/src/lib/claude.js`
- **Responsibility:** Story → JSON array of exactly 8 prompts + voice direction + scene continuity tags.
- **Spec reqs:** prompts include `<character>`, `<scene>`, `<voice_direction>` tags; exactly 8; valid JSON; retry on malformed output
- **Eval:** returns exactly 8; valid JSON; each carries all 3 tags; sample output passes validation; malformed output is caught and retried
- **Fallback:** Qwen via `QWEN_API_KEY` if Claude fails

### C5 — Voice Cloning & Synthesis (PARALLEL)
- **Path:** `packages/studio/src/builder/voice-lock.js`
- **Responsibility:** Reference voice audio (5–30s) → voice embedding; TTS prompts across 8 clips → .wav files.
- **Spec reqs:** Wan2GP voice cloning (Ref2VA or equivalent); Qwen3 TTS or MiniMax H3 for synthesis; 1 voice per character; output .wav files named by clip
- **Eval:** voice embedding is deterministic (same reference audio = same embedding); synthesized audio is 60–65s per clip (matches video duration); audio is lossless or near-lossless
- **Depends on:** Wan2GP voice cloning + TTS endpoints; reference voice audio provided at C5 invocation

### C6 — Caption Generation (PARALLEL)
- **Path:** `packages/studio/src/builder/captions.js`
- **Responsibility:** Claude prompts → SRT subtitle file with timing.
- **Spec reqs:** Parse prompts; generate 3–5 captions per clip (~12s per caption); output valid .srt file with timecodes; captions match prompt intent
- **Eval:** SRT parses without error; timecodes are sequential and non-overlapping; captions are readable (40–60 chars); coverage = 100% of video runtime
- **Depends on:** C4 (Claude prompts)

### C7 — 8-Pass Engine + Concat (SERIAL, depends on C1–C6)
- **Path:** `packages/studio/src/builder/8pass.js`
- **Responsibility:** Orchestrate C1–C6 into full loop: 8x (video + audio + caption) → concat into single 8-min mp4.
- **Spec reqs:** queue-driven (poll Wan2GP queue, do not block); resumable (persist queue state); concat video + audio + captions via ffmpeg; final output ≈ 480–495s (8–8.25 min)
- **Eval:** all 8 clips produced in order; clip N+1 first frame continuous with clip N last frame; audio synced to video; captions burned or sidecar .srt; final mp4 plays end-to-end; failure at clip K logs K and does not truncate
- **Depends on:** C1, C2, C3, C4, C5, C6; ffmpeg; Wan2GP queue persistence

### C8 — UI Wiring (SERIAL, depends on C1–C7)
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
| B1 | Git remote: `acndintllc/stitched-higgsfield-builder` does not exist. | User must create on GitHub. | Work is currently local. Push after creation. |
| B2 | `ANTHROPIC_API_KEY` not set. | User has key (confirmed). | C4 (Claude orchestration) buildable + mock-testable; real 8 prompts require activation. |
| B3 | GPU rental: Wan2GP instance not provisioned. | User must rent GPU + SSH tunnel. | C1, C2, C5, C7 require active Wan2GP at `http://127.0.0.1:7860`. Mock testing possible; real clips require GPU. |
| B4 | Reference voice audio not provided. | User to provide or generate via TTS. | C5 (voice cloning) requires 10–30s audio sample. Can use silence placeholder for mock test. |
| B5 | Windows verification impossible in Linux container. | Informational only. | Code will be Windows-compatible. Final acceptance test must run on ThinkCentre. |

---

## APPROVED FOR BUILD (CEO confirmed)

✅ C1–C8 as specified  
✅ Internal voice + captions (no 11 Labs, no CapCut post-production)  
✅ GPU-first architecture (Wan2GP primary, Muapi fallback)  
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
