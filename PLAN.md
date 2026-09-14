# PROJECT: stitched-higgsfield-builder

Windows app, 1 repo, 2 services inside (UI + Engine). Claude writes 8 prompts -> Soul ID + scene lock -> 8x60s = 8min video.

## STACK
- Base: Next.js from `clearsolid/open-higgsfield-ai`
- Desktop: Electron (from base)
- Video Cloud: Muapi API (200 models)
- Video Local: Wan2GP (port 7860) + sd.cpp
- Text: Claude API (Anthropic) + Qwen fallback

## REPOS TO STITCH FROM
1. `clearsolid/open-higgsfield-ai` — UI, Cinema Studio, Video Studio
2. `itskhalidreda/higgsfield` — local engine client, uncensored upload logic
3. `Wan-Video/Wan2.1` — FLF2V nodes for scene lock (lastFrame -> firstFrame)
4. `THUDM/CogKit` — IP-Adapter, PuLID, LoRA for character lock
5. `deepbeepmeep/Wan2GP` — local Windows GPU server (run via `install.bat`)

## CORE FEATURES TO BUILD

1. **Engine Abstraction** `packages/studio/src/engines/`
   - `cloud.js` -> calls Muapi with prompt + image + Soul ID
   - `local-wan2gp.js` -> calls http://127.0.0.1:7860
   - Unified interface: `generate({prompt, firstFrame, soulId}) => {video, lastFrame}`

2. **Character Lock (Soul ID)** `builder/character-lock.js`
   - Input: 3-5 reference images
   - Output: soulId = PuLID + IP-Adapter embedding (from CogKit logic)
   - Pass soulId to every generation

3. **Scene Lock** `builder/scene-lock.js`
   - FLF2V: extract last frame of clip N, use as first frame of clip N+1

4. **8-Pass Engine** `builder/8pass.js`
   - Input: user story
   - Claude API writes 8x prompts (60s each, explicit character + scene continuity)
   - Loop: generate clip -> get lastFrame -> next clip
   - Final: ffmpeg concat 8 clips -> 1 video

5. **Claude Orchestration** `lib/claude.js`
   - Anthropic API, system prompt = Higgsfield director, outputs JSON array of 8 prompts with soul lock tags

## FILE STRUCTURE

```
/app
/packages/studio/src/
  /builder/8pass.js, character-lock.js, scene-lock.js
  /engines/cloud.js, local-wan2gp.js
  /studio/ (from base repo)
/Wan2GP/ (git submodule)
/.env.example
```

## ENV

```
ANTHROPIC_API_KEY=
QWEN_API_KEY=
MUAPI_API_KEY=
LOCAL_VIDEO_URL=http://127.0.0.1:7860
```

## PHASES

- Phase 1: Clone base, get it running in dev mode
- Phase 2: Copy local engine client from `itskhalidreda/higgsfield` into `engines/`
- Phase 3: Implement `engines/` abstraction with switch via ENV
- Phase 4: Implement character-lock (PuLID embedding, store soulId)
- Phase 5: Implement scene-lock (FLF2V lastFrame extraction)
- Phase 6: Implement `lib/claude.js` -> 8 prompt JSON generator
- Phase 7: Implement `builder/8pass.js` loop + ffmpeg concat
- Phase 8: Wire UI: Cinema Studio -> Soul ID upload -> Story input -> Generate -> Progress 1/8 -> Preview

## DEV MACHINE

Lenovo ThinkCentre, Windows. No GPU required for dev — API mode. Future RTX 4070+ enables local mode with no code change.

## ACCEPTANCE

- Dev server runs on Windows
- Input 3 face images + story -> Claude writes 8 prompts -> 8 clips via Muapi with same character + continuous scene -> final 8min mp4
