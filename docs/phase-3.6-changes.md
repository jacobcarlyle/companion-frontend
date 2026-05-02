# Phase 3.6 PWA Change Plan

## Goal

Add a per-person route between the existing OpenAI Realtime session and the new turn-based cascade backend. The live default remains Realtime until `cascade_enabled` is changed for a person in the server voice config.

## Existing Path Kept

- PIN entry stays unchanged.
- When `cascade_enabled` is false, the current `/session` flow still mints an OpenAI Realtime client secret.
- WebRTC, Realtime function calls, shadow STT mirroring, transcript rendering, and `/ingest` stay in place.
- The existing "Finish Chat" button continues to save transcripts.

## New Cascade Path

- After PIN verification, the app calls `/elder-voice-config?personId=<person>`.
- If `cascade_enabled` is true, the main talk button becomes tap-to-start / tap-to-send.
- Audio is captured through `pcm-resampler-worklet.js` and streamed as 16 kHz PCM to `/turn`.
- Streamed PCM response audio is queued locally for playback.
- During `thinking` and `speaking`, button taps are ignored so there is no barge-in.
- User transcripts and assistant tokens are added to the same transcript model used by `/ingest`.

## Manual Gate

Before any elder cutover, deploy a Cloudflare Pages preview and test on Bev's iPad, Tim's iPhone, and Jan's tablet. Confirm microphone permission, tap responsiveness, streamed playback, and the return to idle after the assistant finishes speaking.
