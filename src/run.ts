import {Account, checkUserQuota, queryAccount, search, TraceMoeResponse, TraceMoeResult} from "./trace-api.ts";
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

async function identifyAnimeEpisode(sourceFile: string, apiKey: string, anilist: number | undefined) {
    const results: TraceMoeResponse[] = [];

    const hashes = await extractFrameHashes(sourceFile);

    for (const hash of hashes.values()) {
        results.push(await search(hash, apiKey, anilist));
    }

    // Filter low-confidence results
    const filteredResults = results.map(response => ({
        ...response,
        result: response.result.filter(
            result => result.similarity >= SIMILARITY_THRESHOLD
        ),
    }));

    // Flatten all valid matches into one list
    const matches = filteredResults.flatMap(response => response.result);

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
        const activeKey = await getActiveKey(FRAME_EXTRACT_COUNT);

        if (activeKey === undefined) {
            console.error("No quota available. Please consider sponsoring https://trace.moe");
            return;
        }

        let winner;

        try {
            winner = await identifyAnimeEpisode(file, activeKey, anilist);
        } catch (error) {
            console.error(`Frame extraction/search failed for: ${file}`, error);
            failedCount++;
            continue;
        } finally {
            consumeQuota(activeKey, FRAME_EXTRACT_COUNT);
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

export function consumeQuota(apiKey: string, amount: number): void {
    const cachedAccount = accountCache.get(apiKey);

    if (!cachedAccount) {
        return;
    }

    const oldQuotaUsed = Number(cachedAccount.account.quotaUsed); // Number Temp fix for API returning a string.
    cachedAccount.account.quotaUsed = oldQuotaUsed + amount;
    console.log(`consumeQuota ${oldQuotaUsed} -> ${cachedAccount.account.quotaUsed}`);

    // Clamp in case of rounding or server-side differences.
    cachedAccount.account.quotaUsed = Math.min(
        cachedAccount.account.quotaUsed,
        cachedAccount.account.quota
    );
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
