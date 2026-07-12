import { spawn } from "child_process";
import os from "node:os";
import colorLayout from "./color-layout.ts";

const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 180;
const FRAME_SIZE = VIDEO_WIDTH * VIDEO_HEIGHT * 3; // RGB
export const FRAME_EXTRACT_COUNT = 5; // NOTE: Search multiple to ensure we don't query openings, endings, bumpers or recaps.

// TODO Based on length, adjust the frame gaps to ensure it extracts frames inside the video.
export function extractFrameHashes(inputFile: string, frameCount: number = FRAME_EXTRACT_COUNT): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        let stdoutBuffer = Buffer.alloc(0);
        const output: number[][] = [];

        console.log("Extracting frames from: " + inputFile);

        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-y",
            "-ss", "30",
            "-skip_frame", "nokey",
            "-i", inputFile,
            "-fps_mode", "passthrough",
            "-an",
            "-vf", `fps=1/65,scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}`,
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

        ffmpeg.stdout.on("data", (data) => {
            stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
            while (stdoutBuffer.length >= FRAME_SIZE) {
                const frameBuffer = stdoutBuffer.subarray(0, FRAME_SIZE);
                stdoutBuffer = stdoutBuffer.subarray(FRAME_SIZE);
                const vector = colorLayout(frameBuffer, VIDEO_WIDTH, VIDEO_HEIGHT);
                output.push(vector);
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
