import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { db, schema } from "./db";
import { eq } from "drizzle-orm";

const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET!);

export type AuthUser = {
  id: string;
  role: "instructor" | "student";
  name: string;
  email: string;
  studentId: string | null;
};

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export async function issueToken(user: AuthUser): Promise<string> {
  return new SignJWT({ role: user.role, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}

/** Returns the authenticated user or null. */
export async function getUserFromRequest(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const id = payload.sub;
    if (!id) return null;
    const rows = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    const u = rows[0];
    if (!u) return null;
    return { id: u.id, role: u.role as AuthUser["role"], name: u.name, email: u.email, studentId: u.studentId };
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function requireUser(req: Request): Promise<AuthUser> {
  const u = await getUserFromRequest(req);
  if (!u) throw new HttpError(401, "Unauthorized");
  return u;
}

export function requireInstructor(u: AuthUser): void {
  if (u.role !== "instructor") throw new HttpError(403, "Instructor role required");
}
