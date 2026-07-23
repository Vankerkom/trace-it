import {Account, checkUserQuota, queryAccount, QuotaExceededError, search, TraceMoeResponse, TraceMoeResult} from "./trace-api.ts";
import {extractFrameHashes, FRAME_EXTRACT_COUNT} from "./extract.ts";
import {config} from "./config.ts";
import {resolveVideoFiles} from "./scan.ts";
import {access, mkdir, rename} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const ACCOUNT_CACHE_TTL = 60_000; // 1 minute
const SIMILARITY_THRESHOLD = 0.885;
const MIN_VOTES_REQUIRED = 4;

type EpisodeVote = {
    seriesId: number;
    title: string;
    episode: number | string;
    votes: TraceMoeResult[];
    averageSimilarity: number;
    bestSimilarity: number;
};

async function identifyAnimeEpisode(sourceFile: string, anilist: number | undefined) {
    const hashes = await extractFrameHashes(sourceFile);

    if (hashes.length === 0) {
        return undefined;
    }

    const response = await searchWithQuotaFallback(hashes, anilist);

    // Flatten all per-frame result sets and filter out low-confidence matches
    const matches = response.result
        .flat()
        .filter(result => result.similarity >= SIMILARITY_THRESHOLD);

    // Bucket votes by series + episode
    const buckets = new Map<string, EpisodeVote>();

    for (const match of matches) {
        const seriesId = match.anilist.id;
        const episode = match.episode;
        const key = `${seriesId}:${episode}`;

        if (!buckets.has(key)) {
            buckets.set(key, {
                seriesId,
                title:
                    match.anilist.title.english ??
                    match.anilist.title.romaji ??
                    match.anilist.title.native,
                episode,
                votes: [],
                averageSimilarity: 0,
                bestSimilarity: 0,
            });
        }

        buckets.get(key)!.votes.push(match);
    }

    // Calculate bucket scores
    for (const bucket of buckets.values()) {
        const similarities = bucket.votes.map(v => v.similarity);
        bucket.averageSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
        bucket.bestSimilarity = Math.max(...similarities);
    }

    // Find winning episode
    return [...buckets.values()]
        .filter(bucket => bucket.votes.length >= MIN_VOTES_REQUIRED)
        .sort((a, b) => {
            // Then highest average similarity
            if (b.averageSimilarity !== a.averageSimilarity) {
                return b.averageSimilarity - a.averageSimilarity;
            }

            // Most votes second
            if (b.votes.length !== a.votes.length) {
                return b.votes.length - a.votes.length;
            }

            // Finally best individual match
            return b.bestSimilarity - a.bestSimilarity;
        })[0];
}

export async function runTraceIt(): Promise<void> {
    const { values } = parseArgs({
        options: {
            target: {
                type: "string",
                short: "s",
                required: true,
            },
            output: {
                type: "string",
                short: "o",
                required: true,
            },
            anilist: {
                type: "string",
                short: "a",
            },
        },
    });

    const target = values.target;
    const outputDir = values.output;

    if (!target || !outputDir) {
        console.log("Usage: npm start -- -s ./source -o ./output")
        return;
    }

    let anilist: number | undefined;

    if (values.anilist !== undefined) {
        anilist = Number(values.anilist);

        if (!Number.isFinite(anilist)) {
            console.error(`Invalid --anilist value: "${values.anilist}" is not a number.`);
            return;
        }

        console.log(`Filtering by anilist id: ${anilist}`)
    }

    await createDirectory(outputDir);

    console.log("TraceIt - Because every episode deserves the right name, without the manual work.");
    console.log()

    console.log("Scanning target directory...");
    const files = await resolveVideoFiles(target);
    console.log(`Found ${files.length} potential video files in ${target}`);

    let renamedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let file of files) {
        let winner;

        try {
            winner = await identifyAnimeEpisode(file, anilist);
        } catch (error) {
            if (error instanceof QuotaExhaustedFatalError) {
                return;
            }

            console.error(`Frame extraction/search failed for: ${file}`, error);
            failedCount++;
            continue;
        }

        if (!winner) {
            console.warn(`Could not confidently identify episode for: ${file}`);
            skippedCount++;
            continue;
        }

        console.log({
            series: winner.title,
            episode: winner.episode,
            votes: winner.votes.length,
            averageSimilarity: winner.averageSimilarity,
        });

        // Move the file to a rename folder.
        const newFile = await renameEpisode({
            file,
            series: winner.title,
            episode: winner.episode,
            outputDir: outputDir,
        });

        console.log(`Renamed to: ${newFile}`);
        renamedCount++;
    }

    console.log();
    console.log(`Renamed: ${renamedCount}, skipped (no confident match): ${skippedCount}, failed: ${failedCount}`);
    console.log("TraceIt - Completed, now you can do the rest! Like manually importing them into Sonarr to for your media server.");
}

export interface RenameEpisodeOptions {
    file: string;
    series: string;
    episode: number | string;
    outputDir?: string;
}

/**
 * Adjust this function to change the filename format.
 * Current format: "{series} E{episode:XX}.{ext}"
 */
function buildFilename(
    {
        series,
        episode,
        ext,
    }: {
        series: string;
        episode: number | string;
        ext: string;
    }): string {

    return `${sanitizeFilename(series)} E${episode.toString().padStart(2, "0")}${ext}`;
}

export async function renameEpisode(
    {
        file,
        series,
        episode,
        outputDir,
    }: RenameEpisodeOptions): Promise<string> {
    const ext = path.extname(file);

    const newName = buildFilename({
        series,
        episode,
        ext,
    });

    const targetDir = outputDir ?? path.dirname(file);

    // Safe if the directory already exists.
    await mkdir(targetDir, {recursive: true});

    const newPath = path.join(targetDir, newName);

    await assertFileDoesNotExist(newPath);

    await rename(file, newPath);

    return newPath;
}

type AccountCache = {
    key: string;
    account: Account;
    fetchedAt: number;
}

const accountCache = new Map<string, AccountCache>();


async function getAccount(apiKey: string): Promise<Account | null> {
    const now = Date.now();
    const cachedAccount = accountCache.get(apiKey);

    if (cachedAccount) {
        const ttl = now - cachedAccount.fetchedAt;

        if (ttl < ACCOUNT_CACHE_TTL) {
            return cachedAccount.account;
        } else {
            console.log(`getAccount ${apiKey} ttl > cache ttl -> ${ttl}`);
        }
    } else {
        console.log(`getAccount ${apiKey} not cached`);
    }

    const account = await queryAccount(apiKey);

    if (!account) {
        return null;
    }

    accountCache.set(apiKey, {
        key: apiKey,
        account,
        fetchedAt: Date.now(),
    });

    return account;
}


/**
 * Selects the best available API key.
 *
 * Strategy:
 * 1. Try public quota first.
 * 2. If public quota is insufficient, try TRACE_KEY.
 * 3. Return undefined when no quota is available.
 */
export async function getActiveKey(
    requiredQuota: number
): Promise<string | undefined> {
    // Public quota first
    const publicAccount = await getAccount('');

    if (publicAccount && checkUserQuota(publicAccount, requiredQuota)) {
        return '';
    }

    // Public quota exhausted, try API key
    if (config.TRACE_API_KEY) {
        const apiAccount = await getAccount(config.TRACE_API_KEY);
        if (apiAccount && checkUserQuota(apiAccount, requiredQuota)) {
            return config.TRACE_API_KEY;
        }
    } else {
        console.warn(`No API key configured, public quota reached.`);
    }

    return undefined;
}

export function updateAccountQuota(apiKey: string, quota: number, quotaUsed: number): void {
    const cachedAccount = accountCache.get(apiKey);

    if (!cachedAccount) {
        return;
    }

    console.log(`updateAccountQuota ${cachedAccount.account.quotaUsed} -> ${quotaUsed}`);

    cachedAccount.account.quota = quota;
    cachedAccount.account.quotaUsed = quotaUsed;
    cachedAccount.fetchedAt = Date.now();
}

// Signals that no tier (free or API key) has quota left; the run should stop entirely.
class QuotaExhaustedFatalError extends Error {}

function reportQuotaExhausted(): void {
    if (!config.TRACE_API_KEY) {
        console.warn("Free tier quota consumed.");
        console.error("No quota available. Please consider sponsoring https://trace.moe");
        return;
    }

    const retryAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    console.error(`API key quota exhausted. Please try again after ${retryAt.toLocaleString()} (~24 hours from now).`);
}

/**
 * Searches using the best available key, checking local quota knowledge before every
 * attempt so we never call the API for a tier we already know is out of budget.
 * Falls back from the free tier to TRACE_API_KEY (if configured) on a live 402, since
 * the shared public/IP-based tier can be drained by other users between our checks.
 */
async function searchWithQuotaFallback(
    hashes: number[][],
    anilist: number | undefined,
): Promise<TraceMoeResponse> {
    let apiKey = await getActiveKey(FRAME_EXTRACT_COUNT);

    while (apiKey !== undefined) {
        try {
            const response = await search(hashes, apiKey, anilist);
            updateAccountQuota(apiKey, response.quota, response.quotaUsed);
            return response;
        } catch (error) {
            if (!(error instanceof QuotaExceededError)) {
                throw error;
            }

            updateAccountQuota(apiKey, error.quota, error.quotaUsed);

            if (apiKey === '' && config.TRACE_API_KEY) {
                console.warn("Free tier quota exhausted, switching to configured TRACE_API_KEY.");
            }

            const nextKey = await getActiveKey(FRAME_EXTRACT_COUNT);

            if (nextKey === apiKey) { // Switched to the same key, we wanted to switch so stop.
                break;
            }

            apiKey = nextKey;
        }
    }

    reportQuotaExhausted();
    throw new QuotaExhaustedFatalError();
}

async function createDirectory(path: string): Promise<void> {
    try {
        await mkdir(path, {recursive: true});
        console.log(`Directory created: ${path}`);
    } catch (error) {
        console.error(`Failed to create directory "${path}":`, error);
    }
}

function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, "") // Windows invalid chars
        .replace(/\s+/g, " ")
        .trim();
}

async function assertFileDoesNotExist(file: string): Promise<void> {
    try {
        await access(file);
        throw new Error(`Destination file already exists: ${file}`);
    } catch (error: any) {
        // ENOENT means the file does not exist, which is what we want.
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}
