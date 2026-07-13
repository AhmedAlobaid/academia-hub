import type { Config } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db, schema } from "../../lib/db";
import { hashPassword } from "../../lib/auth";

export const config: Config = { path: "/db-seed" };

const DEMO_PASSWORD = "Academia-2026!";

/**
 * One-time demo data seeding from the browser:
 *   /db-seed?secret=YOUR_AUTH_SECRET
 * Creates a demo instructor, a demo student, and course MED-301.
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== process.env.AUTH_SECRET) {
    return page("❌ Wrong or missing secret", "Open as /db-seed?secret=YOUR_AUTH_SECRET", false, 403);
  }

  try {
    const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (existing.length) {
      return page("ℹ️ Already seeded", "Demo data exists — nothing to do.", true);
    }

    const hash = await hashPassword(DEMO_PASSWORD);

    const [inst] = await db.insert(schema.users).values({
      role: "instructor",
      name: "د. أحمد الخالدي / Dr. Ahmed Al-Khalidi",
      email: "instructor@academia.hub",
      passwordHash: hash
    }).returning();

    const [stu] = await db.insert(schema.users).values({
      role: "student",
      name: "محمد العلي / Mohammed Al-Ali",
      email: "student@academia.hub",
      passwordHash: hash,
      studentId: "20240001"
    }).returning();

    const [course] = await db.insert(schema.courses).values({
      name: "مبادئ علم الأدوية الأساسية / Basic Pharmacology",
      code: "MED-301",
      description: "Cardiac and vascular pharmacology essentials.",
      joinCode: "MED301A",
      instructorId: inst.id
    }).returning();

    await db.insert(schema.enrollments).values({ courseId: course.id, studentId: stu.id });

    const inWeek = new Date(Date.now() + 7 * 86400000).toISOString();
    await db.insert(schema.assignments).values({
      courseId: course.id,
      title: "الواجب 1: ملخص الدوائر الدموية / Assignment 1: CV Summary",
      instructions: "اكتب ملخصاً لآليات عمل أدوية القلب. / Summarize cardiac drug mechanisms.",
      maxGrade: 10,
      openDate: new Date().toISOString(),
      closeDate: inWeek
    });

    await db.insert(schema.announcements).values({
      courseId: course.id,
      authorId: inst.id,
      content: "مرحباً بكم في المقرر. / Welcome to the course."
    });

    return page(
      "✅ Demo data created",
      `<b>Instructor:</b> instructor@academia.hub<br>
       <b>Student:</b> student@academia.hub<br>
       <b>Password (both):</b> <code>${DEMO_PASSWORD}</code><br><br>
       Course <b>MED-301</b> created with one assignment and one announcement.<br><br>
       ⚠️ Change these passwords before real use.`,
      true,
      201
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return page("❌ Seeding failed", esc(msg) + "<br><br>Did you run <code>/db-setup</code> first?", false, 500);
  }
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function page(title: string, body: string, ok: boolean, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <title>${esc(title)}</title>
     <div style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:32px;
                 border:1px solid #E5E7EB;border-radius:12px;line-height:1.7;">
       <h1 style="color:${ok ? "#059669" : "#DC2626"};margin:0 0 12px;">${esc(title)}</h1>
       <div style="color:#374151;">${body}</div>
     </div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
