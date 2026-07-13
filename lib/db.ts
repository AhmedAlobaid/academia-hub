import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../db/schema";

export const db = drizzle(neon(process.env.NETLIFY_DATABASE_URL!), { schema });
export { schema };
