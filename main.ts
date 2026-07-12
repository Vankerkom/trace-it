import {runTraceIt} from "./src/run.ts";
import {ensureFFMpegToolsInstalled} from "./src/dependency-check.ts";

async function main(): Promise<void> {
    await ensureFFMpegToolsInstalled();
    await runTraceIt();
}

main().catch((err) => {
    console.error("[app] Fatal error during startup:", err);
    process.exit(1);
});
