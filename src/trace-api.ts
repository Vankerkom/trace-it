export type Account = {
    id: string;
    priority: number;
    concurrency: number;
    quota: number;
    quotaUsed: number;
}

export async function queryAccount(apiKey: string = ''): Promise<Account | null> {
    console.log("queryAccount -> https://api.trace.moe/me");

    const response = await fetch("https://api.trace.moe/me", {
        headers: {
            ...(apiKey && {"x-trace-key": apiKey}),
        },
    });

    if (!response.ok) {
        console.error(`HTTP ${response.status}: ${response.statusText}`);
        return null;
    }

    return (await response.json()) as Account;
}

export function checkUserQuota(account: Account, requiredQuota: number = 1) {
    return Number(account.quotaUsed) + requiredQuota <= account.quota;
}

type AniListTitle = {
    native: string;
    romaji: string;
    chinese: string;
    english: string;
};

type AniListDate = {
    day: number;
    year: number;
    month: number;
};

type AniListInfo = {
    id: number;
    type: string;
    idMal: number;
    title: AniListTitle;
    format: string;
    genres: string[];
    season: string;
    source: string;
    status: string;
    endDate: AniListDate;
    isAdult: boolean;
    siteUrl: string;
};

export type TraceMoeResult = {
    anilist: AniListInfo | any;
    filename: string;
    episode: number | string;
    from: number;
    at: number;
    to: number;
    duration: number;
    similarity: number;
    video: string;
    image: string;
};

export type TraceMoeResponse = {
    frameCount: number;
    error: string;
    result: TraceMoeResult[];
    quota: number;
    quotaUsed: number;
};

export async function search(
    vector: number[],
    apiKey: string,
    anilist: number | undefined,
): Promise<TraceMoeResponse> {
    const url = `https://api.trace.moe/search?anilistInfo=2${anilist !== undefined ? `&anilistID=${anilist}` : ""}`;
    console.log("search -> ", url);
    // We could filter even more if we know the exact series.
    // Example: &anilistID=116742
    const response = await fetch(
        url,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey && {"x-trace-key": apiKey}),
            },
            body: JSON.stringify({
                vector,
            }),
        }
    );

    if (!response.ok) {
        throw new Error(
            `trace.moe request failed: ${response.status} ${response.statusText}`
        );
    }

    const data = (await response.json()) as TraceMoeResponse;

    if (data.error) {
        throw new Error(`trace.moe API error: ${data.error}`);
    }

    return data;
}