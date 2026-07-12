// Native .env loading (stable since Node.js 22.21 / 24.10 — no "dotenv" package needed).
// Falls back silently if no .env file is present (e.g. in production where env vars are injected directly).
try {
  process.loadEnvFile();
} catch {
  // no .env file found — that's fine, rely on already-set env vars
}

export type Config = {
  TRACE_API_KEY: string;
};

export const config: Config = {
  TRACE_API_KEY: process.env["TRACE_API_KEY"] ?? "",
};
