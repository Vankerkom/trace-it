// Benchmarks extractFrameHashes (single ffmpeg process, fps-filtered) against
// extractFrameHashesParallel (one ffmpeg process per timestamp, run in parallel).
//
// Usage: tsx scripts/benchmark-extract.ts <path-to-video-file>

import { extractFrameHashes, extractFrameHashesParallel } from "../src/extract.ts";

const inputFile = process.argv[2];

if (!inputFile) {
    console.error("Usage: tsx scripts/benchmark-extract.ts <path-to-video-file>");
    process.exit(1);
}

async function time(label: string, run: () => Promise<number[][]>) {
    const start = performance.now();
    const result = await run();
    const elapsedMs = performance.now() - start;
    console.log(`${label}: ${elapsedMs.toFixed(0)}ms, ${result.length} frames`);
    return { elapsedMs, result };
}

const sequential = await time("extractFrameHashes (sequential fps-filter)", () => extractFrameHashes(inputFile));
const parallel = await time("extractFrameHashesParallel (per-timestamp seeks)", () => extractFrameHashesParallel(inputFile));

const speedup = sequential.elapsedMs / parallel.elapsedMs;
console.log(`\nSpeedup: ${speedup.toFixed(2)}x`);
