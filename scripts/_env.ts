/** Shared bootstrap for the pipeline scripts. Import for side effects, first. */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const local = resolve(process.cwd(), ".env.local");
config({ path: existsSync(local) ? local : resolve(process.cwd(), ".env"), quiet: true });

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/** Parses `--flag value` and `--flag=value` from argv. */
export function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const exact = argv.indexOf(`--${name}`);
  if (exact !== -1 && argv[exact + 1] && !argv[exact + 1].startsWith("--")) {
    return argv[exact + 1];
  }
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

export function numericArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

export function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

export const USER_AGENT =
  "movieMap/0.1 (https://github.com/jessbuilt/movieMap; hobby project) node-fetch";

/** Simple sequential progress line that overwrites itself. */
export function progress(done: number, total: number, label: string): void {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  process.stdout.write(`\r  ${label}: ${done}/${total} (${pct}%)   `);
  if (done === total) process.stdout.write("\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True when this module is the entry point rather than an import.
 *
 * Scripts that export helpers must guard their `main()` with this, or merely
 * importing the helper (from a test, say) kicks off the whole pipeline.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
