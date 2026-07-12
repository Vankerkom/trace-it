import { readdir, stat as fsStat } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** Extensions treated as video files when scanning directories. */
export const DEFAULT_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
    '.mp4',
    '.mkv',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.m4v',
    '.mpg',
    '.mpeg',
    '.ts',
    '.m2ts',
]);

export interface ScanOptions {
    recursive: boolean;
    extensions: ReadonlySet<string>;
}

const DEFAULT_SCAN_OPTIONS: ScanOptions = {
    recursive: true,
    extensions: DEFAULT_VIDEO_EXTENSIONS,
};

/**
 * Resolves a single path (file or directory) into a flat list of video file paths.
 * If `targetPath` is a file, it is returned as-is when it matches a video extension.
 * If it's a directory, it is walked (recursively by default) collecting video files.
 */
export async function resolveVideoFiles(
    targetPath: string,
    options: Partial<ScanOptions> = {},
): Promise<string[]> {
    const resolvedOptions: ScanOptions = { ...DEFAULT_SCAN_OPTIONS, ...options };
    const targetStat = await fsStat(targetPath);

    if (targetStat.isFile()) {
        return isVideoFile(targetPath, resolvedOptions.extensions) ? [targetPath] : [];
    }

    if (targetStat.isDirectory()) {
        return scanDirectory(targetPath, resolvedOptions);
    }

    return [];
}

async function scanDirectory(directoryPath: string, options: ScanOptions): Promise<string[]> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
        const entryPath = join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            if (options.recursive) {
                const nested = await scanDirectory(entryPath, options);
                results.push(...nested);
            }
            continue;
        }

        if (entry.isFile() && isVideoFile(entryPath, options.extensions)) {
            results.push(entryPath);
        }
    }

    return results;
}

function isVideoFile(filePath: string, extensions: ReadonlySet<string>): boolean {
    return extensions.has(extname(filePath).toLowerCase());
}
