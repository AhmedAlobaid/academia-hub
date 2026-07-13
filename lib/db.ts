import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../db/schema";

/**
 * Lazy database client.
 * Connecting at module load time crashes the entire function when the
 * environment variable is missing; this defers connection until first use
 * so routes can return a clear error instead of a stack trace.
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDb() {
  if (_db) return _db;
  const url = process.env.NETLIFY_DATABASE_URL;
  if (!url) {
    throw new Error(
      "NETLIFY_DATABASE_URL is not set. Connect a database in the Netlify Database tab, then redeploy."
    );
  }
  _db = drizzle(neon(url), { schema });
  return _db;
}

/** Proxy keeps `db.select(...)` working while staying lazy. */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  }
});

export { schema };
