# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trace It is a Node.js/TypeScript CLI that identifies ripped anime Blu-ray episodes. It extracts frames from video files with FFmpeg, computes a perceptual color-layout hash for each frame, queries trace.moe to find the matching series/episode, and renames the file accordingly (`{series} E{episode}.{ext}`). Built for archiving Blu-ray rips where filenames/hashes don't match existing databases (e.g. reordered episodes used as copy protection).

## Commands

- `npm install` — install dependencies
- `npm start -- -s ./source -o ./output` — run the tool (source dir, output dir)
- `npm start -- -s ./source -o ./output -a 9253` — same, filtered to a specific AniList series ID
- There is no build step: `tsx` runs `main.ts` directly. `tsconfig.json` has `noEmit: true`.
- There is no test suite configured (`npm test` is a placeholder that exits with an error) and no lint script.

### Requirements to run

- Node.js 24 LTS+ (uses `process.loadEnvFile()`, native `.env` support — no `dotenv` package)
- FFmpeg and FFprobe available on PATH — checked at startup by `ensureFFMpegToolsInstalled` in `src/dependency-check.ts`, which exits the process if missing
- Optional: `TRACE_API_KEY` in `.env` for higher trace.moe quota (falls back to the public/free tier first)

## Architecture

Entry point `main.ts` → `ensureFFMpegToolsInstalled()` then `runTraceIt()` in `src/run.ts`, which is the orchestrator for the whole pipeline:

1. **`src/scan.ts`** — recursively walks the source path (or accepts a single file) and returns video files matching known extensions (`DEFAULT_VIDEO_EXTENSIONS`).
2. **`src/extract.ts`** — for each source file, spawns `ffmpeg` to extract `FRAME_EXTRACT_COUNT` (5) downscaled (320x180) key frames as raw RGB, starting 30s in and spaced 65s apart (to skip openings/endings/bumpers/recaps). Each frame buffer is piped into `src/color-layout.ts` as it arrives.
3. **`src/color-layout.ts`** — implements the MPEG-7 Color Layout Descriptor: partitions each frame into an 8x8 grid, averages YCbCr per block, applies a 2D DCT, zig-zags and quantizes into a 33-value feature vector. This is a hot path with hand-tuned typed-array reuse (module-level scratch buffers, avoided allocations) — treat it as perf-sensitive and preserve the buffer-reuse pattern if touched.
4. **`src/trace-api.ts`** — thin wrapper around the trace.moe HTTP API: `queryAccount` (quota/`GET /me`), `search` (`POST /search` with the feature vector, optionally scoped to an AniList ID), `checkUserQuota`.
5. Back in **`src/run.ts`**:
   - `identifyAnimeEpisode` searches once per extracted frame hash, filters matches below `SIMILARITY_THRESHOLD` (0.885), buckets remaining matches by `seriesId:episode`, and requires `MIN_VOTES_REQUIRED` (4) matching frames before picking a winner (ranked by average similarity, then vote count, then best single similarity). This multi-frame voting is what makes the tool robust against a single frame matching a recap/OP/ED.
   - `getActiveKey` / `getAccount` / `consumeQuota` implement quota management: try the public/free trace.moe tier first, fall back to `TRACE_API_KEY` from config only if the free tier is exhausted; account info is cached in-memory for `ACCOUNT_CACHE_TTL` (1 minute) and quota usage is tracked locally between calls to avoid re-querying `/me` before every search.
   - `renameEpisode` / `buildFilename` move the identified file into `outputDir`, sanitizing the series name for filesystem safety and refusing to overwrite an existing destination file (`assertFileDoesNotExist`).

**`src/config.ts`** loads `.env` via Node's native `process.loadEnvFile()` (silently no-ops if absent) and exposes `TRACE_API_KEY`.

Everything is ESM TypeScript executed directly via `tsx` (`"type": "module"`, imports use explicit `.ts` extensions per `allowImportingTsExtensions`). `tsconfig.json` runs in strict mode with `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` — index access on arrays/records needs care (see `config.ts`'s `process.env["TRACE_API_KEY"]` bracket style).
