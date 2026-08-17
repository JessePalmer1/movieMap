import { Pool, PoolClient } from "pg";

/**
 * Postgres access.
 *
 * A module-level pool, reused across hot reloads in development so that editing
 * a file does not leak connections (Next.js re-evaluates modules on change).
 */

declare global {
  var __moviemapPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!global.__moviemapPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Copy .env.example to .env.local, then run `npm run db:up`.",
      );
    }
    global.__moviemapPool = new Pool({ connectionString, max: 10 });
  }
  return global.__moviemapPool;
}

// No `extends Record<string, unknown>` constraint: a plain interface has no
// implicit index signature, so constraining the row type would reject every
// row shape we actually declare.
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// pgvector serialisation
//
// node-postgres has no native codec for the `vector` type, so it arrives as the
// text form '[1,2,3]' and must be sent the same way.
// ---------------------------------------------------------------------------

export function formatVector(v: number[]): string {
  for (const x of v) {
    if (!Number.isFinite(x)) {
      throw new Error(`formatVector: refusing to store a non-finite value (${x})`);
    }
  }
  return `[${v.join(",")}]`;
}

export function parseVector(value: string | number[] | null): number[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== "[" || trimmed[trimmed.length - 1] !== "]") {
    throw new Error(`parseVector: malformed vector literal ${JSON.stringify(value)}`);
  }
  const body = trimmed.slice(1, -1);
  if (body.trim() === "") return [];
  return body.split(",").map((part) => {
    const n = Number(part);
    if (Number.isNaN(n)) {
      throw new Error(`parseVector: non-numeric component ${JSON.stringify(part)}`);
    }
    return n;
  });
}
