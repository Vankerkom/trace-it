import { spawn } from "child_process";
import os from "node:os";
import colorLayout from "./color-layout.ts";

const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 180;
const FRAME_SIZE = VIDEO_WIDTH * VIDEO_HEIGHT * 3; // RGB
export const FRAME_EXTRACT_COUNT = 5; // NOTE: Search multiple to ensure we don't query openings, endings, bumpers or recaps.
const FRAME_START_OFFSET_SECONDS = 35; // Using this offset on purpose to not hit into intros too much.
const FRAME_INTERVAL_SECONDS = 65;

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
            "-threads", "1",
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

// TODO Based on length, adjust the frame gaps to ensure it extracts frames inside the video.
// Spawns one ffmpeg process per target timestamp, each seeking directly to its frame, run in
// parallel. This avoids decoding every keyframe between the start offset and the last target
// timestamp, which is what a single-process fps-filter approach would do.
export function extractFrameHashes(inputFile: string, frameCount: number = FRAME_EXTRACT_COUNT): Promise<number[][]> {
    console.log("Extracting frames from: " + inputFile);

    const timestamps = Array.from({ length: frameCount }, (_, i) => FRAME_START_OFFSET_SECONDS + i * FRAME_INTERVAL_SECONDS);

    return Promise.all(timestamps.map((timestamp) => extractSingleFrameHash(inputFile, timestamp))).then((hashes) => {
        console.log("Finished Extracting frames from: " + inputFile);
        return hashes;
    });
}
