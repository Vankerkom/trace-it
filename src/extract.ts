import { spawn } from "child_process";
import os from "node:os";
import colorLayout from "./color-layout.ts";

const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 180;
const FRAME_SIZE = VIDEO_WIDTH * VIDEO_HEIGHT * 3; // RGB
export const FRAME_EXTRACT_COUNT = 5; // NOTE: Search multiple to ensure we don't query openings, endings, bumpers or recaps.
const FRAME_START_OFFSET_SECONDS = 30;
const FRAME_INTERVAL_SECONDS = 65;

// TODO Based on length, adjust the frame gaps to ensure it extracts frames inside the video.
export function extractFrameHashes(inputFile: string, frameCount: number = FRAME_EXTRACT_COUNT): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        // Reused across frames instead of Buffer.concat-ing every incoming chunk,
        // which would re-copy the whole accumulated buffer on each "data" event.
        const frameBuffer = Buffer.allocUnsafe(FRAME_SIZE);
        let frameOffset = 0;
        const output: number[][] = [];

        console.log("Extracting frames from: " + inputFile);

        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-y",
            "-ss", FRAME_START_OFFSET_SECONDS.toString(),
            "-skip_frame", "nokey",
            "-i", inputFile,
            "-fps_mode", "passthrough",
            "-an",
            "-vf", `fps=1/${FRAME_INTERVAL_SECONDS},scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`,
            "-frames:v", frameCount.toString(),
            "-c:v",
            "rawvideo",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ];

        const ffmpeg = spawn("ffmpeg", args);

        os.setPriority(ffmpeg.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);

        ffmpeg.stdout.on("data", (data: Buffer) => {
            let dataOffset = 0;
            while (dataOffset < data.length) {
                const bytesToCopy = Math.min(FRAME_SIZE - frameOffset, data.length - dataOffset);
                data.copy(frameBuffer, frameOffset, dataOffset, dataOffset + bytesToCopy);
                frameOffset += bytesToCopy;
                dataOffset += bytesToCopy;

                if (frameOffset === FRAME_SIZE) {
                    const vector = colorLayout(frameBuffer, VIDEO_WIDTH, VIDEO_HEIGHT);
                    output.push(vector);
                    frameOffset = 0;
                }
            }
        });

        ffmpeg.stderr.on("data", (data: Buffer) => {
            console.error(data.toString());
        });

        ffmpeg.on("close", (code: number | null) => {
            if (code === 0) {
                console.log("Finished Extracting frames from: " + inputFile);
                resolve(output);
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on("error", (error: Error) => {
            reject(error);
        });
    });
}

// Extracts a single frame at an exact timestamp by seeking directly to it,
// instead of decoding every keyframe between the start offset and that timestamp.
function extractSingleFrameHash(inputFile: string, timestampSeconds: number): Promise<number[]> {
    return new Promise((resolve, reject) => {
        const frameBuffer = Buffer.allocUnsafe(FRAME_SIZE);
        let frameOffset = 0;
        let vector: number[] | null = null;

        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-y",
            "-ss", timestampSeconds.toString(),
            "-skip_frame", "nokey",
            "-i", inputFile,
            "-an",
            "-vf", `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`,
            "-frames:v", "1",
            "-c:v",
            "rawvideo",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ];

        const ffmpeg = spawn("ffmpeg", args);

        os.setPriority(ffmpeg.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);

        ffmpeg.stdout.on("data", (data: Buffer) => {
            let dataOffset = 0;
            while (dataOffset < data.length && frameOffset < FRAME_SIZE) {
                const bytesToCopy = Math.min(FRAME_SIZE - frameOffset, data.length - dataOffset);
                data.copy(frameBuffer, frameOffset, dataOffset, dataOffset + bytesToCopy);
                frameOffset += bytesToCopy;
                dataOffset += bytesToCopy;
            }

            if (frameOffset === FRAME_SIZE && vector === null) {
                vector = colorLayout(frameBuffer, VIDEO_WIDTH, VIDEO_HEIGHT);
            }
        });

        ffmpeg.stderr.on("data", (data: Buffer) => {
            console.error(data.toString());
        });

        ffmpeg.on("close", (code: number | null) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited with code ${code}`));
            } else if (vector === null) {
                reject(new Error(`ffmpeg produced no frame at ${timestampSeconds}s for ${inputFile}`));
            } else {
                resolve(vector);
            }
        });

        ffmpeg.on("error", (error: Error) => {
            reject(error);
        });
    });
}

/**
 * PROTOTYPE for benchmarking against extractFrameHashes — not wired into the pipeline yet.
 *
 * Spawns one ffmpeg process per target timestamp, each seeking directly to its frame,
 * run in parallel. This avoids decoding every keyframe between the start offset and the
 * last target timestamp (what the single-process fps-filter approach does), at the cost
 * of N process/file-open overheads instead of one. Whether this is actually faster
 * depends on keyframe density and per-process spawn overhead — benchmark before adopting.
 */
export function extractFrameHashesParallel(inputFile: string, frameCount: number = FRAME_EXTRACT_COUNT): Promise<number[][]> {
    const timestamps = Array.from({ length: frameCount }, (_, i) => FRAME_START_OFFSET_SECONDS + i * FRAME_INTERVAL_SECONDS);
    return Promise.all(timestamps.map((timestamp) => extractSingleFrameHash(inputFile, timestamp)));
}
