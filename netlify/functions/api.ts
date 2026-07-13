import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../../lib/db";
import {
  requireUser, requireInstructor, hashPassword, verifyPassword, issueToken, HttpError, AuthUser
} from "../../lib/auth";
import { json, err, readJson } from "../../lib/http";
import type { ExamQuestion, SubmissionFile } from "../../db/schema";

export const config: Config = { path: "/api/*" };

/* =========================================================
   Helpers
   ========================================================= */
const genJoinCode = (code: string) =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) + Math.floor(100 + Math.random() * 900);

async function myCourseIds(u: AuthUser): Promise<string[]> {
  if (u.role === "instructor") {
    const rows = await db.select({ id: schema.courses.id }).from(schema.courses)
      .where(eq(schema.courses.instructorId, u.id));
    return rows.map(r => r.id);
  }
  const rows = await db.select({ id: schema.enrollments.courseId }).from(schema.enrollments)
    .where(eq(schema.enrollments.studentId, u.id));
  return rows.map(r => r.id);
}

async function assertCourseMember(u: AuthUser, courseId: string) {
  const ids = await myCourseIds(u);
  if (!ids.includes(courseId)) throw new HttpError(403, "Not a member of this course");
}

async function assertCourseInstructor(u: AuthUser, courseId: string) {
  requireInstructor(u);
  const rows = await db.select({ id: schema.courses.id }).from(schema.courses)
    .where(and(eq(schema.courses.id, courseId), eq(schema.courses.instructorId, u.id)));
  if (!rows.length) throw new HttpError(403, "Not the instructor of this course");
}

async function notify(userIds: string[], type: string, message: string) {
  if (!userIds.length) return;
  await db.insert(schema.notifications)
    .values(userIds.map(userId => ({ userId, type, message })));
}

async function courseStudentIds(courseId: string): Promise<string[]> {
  const rows = await db.select({ id: schema.enrollments.studentId }).from(schema.enrollments)
    .where(eq(schema.enrollments.courseId, courseId));
  return rows.map(r => r.id);
}

async function effectiveDeadline(assignmentId: string, studentId: string): Promise<string> {
  const [a] = await db.select().from(schema.assignments).where(eq(schema.assignments.id, assignmentId));
  if (!a) throw new HttpError(404, "Assignment not found");
  const exts = await db.select().from(schema.assignmentExtensions)
    .where(and(
      eq(schema.assignmentExtensions.assignmentId, assignmentId),
      or(eq(schema.assignmentExtensions.studentId, studentId), isNull(schema.assignmentExtensions.studentId))
    ));
  const personal = exts.find(e => e.studentId === studentId);
  if (personal) return personal.closeDate;
  const global = exts.find(e => e.studentId === null);
  return global ? global.closeDate : a.closeDate;
}

/** Server-side auto-grading — correct answers never leave the server. */
function gradeQuestion(q: ExamQuestion, answer: unknown): number {
  if (answer === undefined || answer === null || answer === "") return 0;
  if (q.type === "single") return answer === q.correctAnswer ? q.points : 0;
  if (q.type === "truefalse") return Boolean(answer) === q.correctAnswer ? q.points : 0;
  if (q.type === "short") {
    const a = String(answer).trim().toLowerCase();
    const c = String(q.correctAnswer ?? "").trim().toLowerCase();
    if (a === c) return q.points;
    if (q.tolerance === "low" && a.replace(/[^a-z0-9\u0600-\u06FF]/g, "") === c.replace(/[^a-z0-9\u0600-\u06FF]/g, "")) return q.points;
  }
  return 0; // essay → manual
}

/** Strip answer keys before sending exam questions to students. */
const sanitizeQuestions = (qs: ExamQuestion[]) =>
  qs.map(({ correctAnswer, tolerance, ...rest }) => rest);

const blobStore = () => getStore("submissions");
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // per file (function payload limit safety)

/* =========================================================
   Router
   ========================================================= */
export default async (req: Request) => {
  const url = new URL(req.url);
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method.toUpperCase();

  try {
    /* ---------- AUTH ---------- */
    if (seg[0] === "auth") {
      if (method === "POST" && seg[1] === "signup") {
        const b = await readJson<{ email: string; password: string; name: string; role: string; studentId?: string }>(req);
        if (!b.email || !b.password || !b.name) throw new HttpError(400, "email, password, name required");
        if (b.password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
        const role = b.role === "instructor" ? "instructor" : "student";
        const existing = await db.select({ id: schema.users.id }).from(schema.users)
          .where(eq(schema.users.email, b.email.toLowerCase()));
        if (existing.length) throw new HttpError(409, "Email already registered");
        const [u] = await db.insert(schema.users).values({
          email: b.email.toLowerCase(), name: b.name, role,
          studentId: role === "student" ? (b.studentId ?? null) : null,
          passwordHash: await hashPassword(b.password)
        }).returning();
        const user: AuthUser = { id: u.id, role: u.role as AuthUser["role"], name: u.name, email: u.email, studentId: u.studentId };
        return json({ token: await issueToken(user), user }, 201);
      }
      if (method === "POST" && seg[1] === "login") {
        const b = await readJson<{ email: string; password: string }>(req);
        const [u] = await db.select().from(schema.users).where(eq(schema.users.email, (b.email || "").toLowerCase()));
        if (!u || !(await verifyPassword(b.password || "", u.passwordHash))) throw new HttpError(401, "Invalid credentials");
        const user: AuthUser = { id: u.id, role: u.role as AuthUser["role"], name: u.name, email: u.email, studentId: u.studentId };
        return json({ token: await issueToken(user), user });
      }
      if (method === "GET" && seg[1] === "me") {
        return json({ user: await requireUser(req) });
      }
      throw new HttpError(404, "Unknown auth route");
    }

    /* ---------- COURSES ---------- */
    if (seg[0] === "courses") {
      const u = await requireUser(req);

      if (!seg[1]) {
        if (method === "GET") {
          const ids = await myCourseIds(u);
          if (!ids.length) return json({ courses: [] });
          const rows = await db.select().from(schema.courses).where(inArray(schema.courses.id, ids));
          // hide join code from students
          const courses = rows.map(c => u.role === "instructor" ? c : { ...c, joinCode: undefined });
          return json({ courses });
        }
        if (method === "POST") {
          requireInstructor(u);
          const b = await readJson<{ name: string; code: string; description?: string; coverColor?: string }>(req);
          if (!b.name || !b.code) throw new HttpError(400, "name and code required");
          const [c] = await db.insert(schema.courses).values({
            name: b.name, code: b.code.toUpperCase(), description: b.description ?? "",
            coverColor: b.coverColor ?? "#1E3A5F", joinCode: genJoinCode(b.code), instructorId: u.id
          }).returning();
          return json({ course: c }, 201);
        }
      }

      if (seg[1] === "join" && method === "POST") {
        if (u.role !== "student") throw new HttpError(403, "Students only");
        const b = await readJson<{ joinCode: string }>(req);
        const [c] = await db.select().from(schema.courses)
          .where(eq(schema.courses.joinCode, (b.joinCode || "").toUpperCase().trim()));
        if (!c) throw new HttpError(404, "Invalid join code");
        await db.insert(schema.enrollments).values({ courseId: c.id, studentId: u.id }).onConflictDoNothing();
        return json({ course: { ...c, joinCode: undefined } });
      }

      const courseId = seg[1]!;

      if (seg[2] === "people" && method === "GET") {
        await assertCourseMember(u, courseId);
        const rows = await db.select({
          id: schema.users.id, name: schema.users.name, email: schema.users.email,
          studentId: schema.users.studentId
        }).from(schema.enrollments)
          .innerJoin(schema.users, eq(schema.users.id, schema.enrollments.studentId))
          .where(eq(schema.enrollments.courseId, courseId));
        return json({ students: rows });
      }

      if (seg[2] === "students" && seg[3] && method === "DELETE") {
        await assertCourseInstructor(u, courseId);
        await db.delete(schema.enrollments).where(and(
          eq(schema.enrollments.courseId, courseId), eq(schema.enrollments.studentId, seg[3])
        ));
        return json({ ok: true });
      }

      if (seg[2] === "assignments") {
        await assertCourseMember(u, courseId);
        if (method === "GET") {
          const rows = await db.select().from(schema.assignments)
            .where(eq(schema.assignments.courseId, courseId)).orderBy(desc(schema.assignments.createdAt));
          const withDeadline = await Promise.all(rows.map(async a => ({
            ...a,
            effectiveDeadline: u.role === "student" ? await effectiveDeadline(a.id, u.id) : a.closeDate
          })));
          return json({ assignments: withDeadline });
        }
        if (method === "POST") {
          await assertCourseInstructor(u, courseId);
          const b = await readJson<{ title: string; instructions?: string; openDate?: string; closeDate: string; maxGrade?: number }>(req);
          if (!b.title || !b.closeDate) throw new HttpError(400, "title and closeDate required");
          const [a] = await db.insert(schema.assignments).values({
            courseId, title: b.title, instructions: b.instructions ?? "",
            openDate: b.openDate ?? null, closeDate: b.closeDate, maxGrade: b.maxGrade ?? 10
          }).returning();
          await notify(await courseStudentIds(courseId), "assignment", `New assignment: ${a.title}`);
          return json({ assignment: a }, 201);
        }
      }

      if (seg[2] === "exams") {
        await assertCourseMember(u, courseId);
        if (method === "GET") {
          const rows = await db.select().from(schema.exams).where(eq(schema.exams.courseId, courseId));
          const out = rows.map(e => u.role === "instructor" ? e : { ...e, questions: sanitizeQuestions(e.questions) });
          return json({ exams: out });
        }
        if (method === "POST") {
          await assertCourseInstructor(u, courseId);
          const b = await readJson<{ title: string; instructions?: string; availabilityStart?: string; availabilityEnd: string; durationMinutes: number }>(req);
          if (!b.title || !b.availabilityEnd || !b.durationMinutes) throw new HttpError(400, "title, availabilityEnd, durationMinutes required");
          const [e] = await db.insert(schema.exams).values({
            courseId, title: b.title, instructions: b.instructions ?? "",
            availabilityStart: b.availabilityStart ?? new Date().toISOString(),
            availabilityEnd: b.availabilityEnd, durationMinutes: b.durationMinutes
          }).returning();
          return json({ exam: e }, 201);
        }
      }

      if (seg[2] === "announcements") {
        await assertCourseMember(u, courseId);
        if (method === "GET") {
          const anns = await db.select().from(schema.announcements)
            .where(eq(schema.announcements.courseId, courseId)).orderBy(desc(schema.announcements.createdAt));
          const ids = anns.map(a => a.id);
          const comments = ids.length ? await db.select({
            id: schema.announcementComments.id,
            announcementId: schema.announcementComments.announcementId,
            content: schema.announcementComments.content,
            createdAt: schema.announcementComments.createdAt,
            authorName: schema.users.name
          }).from(schema.announcementComments)
            .innerJoin(schema.users, eq(schema.users.id, schema.announcementComments.authorId))
            .where(inArray(schema.announcementComments.announcementId, ids))
            .orderBy(asc(schema.announcementComments.createdAt)) : [];
          return json({
            announcements: anns.map(a => ({ ...a, comments: comments.filter(c => c.announcementId === a.id) }))
          });
        }
        if (method === "POST") {
          await assertCourseInstructor(u, courseId);
          const b = await readJson<{ content: string }>(req);
          if (!b.content) throw new HttpError(400, "content required");
          const [a] = await db.insert(schema.announcements).values({ courseId, authorId: u.id, content: b.content }).returning();
          await notify(await courseStudentIds(courseId), "announcement", "New announcement");
          return json({ announcement: a }, 201);
        }
      }

      if (seg[2] === "modules") {
        await assertCourseMember(u, courseId);
        if (method === "GET") {
          const rows = await db.select().from(schema.contentModules)
            .where(eq(schema.contentModules.courseId, courseId)).orderBy(asc(schema.contentModules.order));
          return json({ modules: rows });
        }
        if (method === "POST") {
          await assertCourseInstructor(u, courseId);
          const b = await readJson<{ title: string }>(req);
          if (!b.title) throw new HttpError(400, "title required");
          const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
            .from(schema.contentModules).where(eq(schema.contentModules.courseId, courseId));
          const [m] = await db.insert(schema.contentModules)
            .values({ courseId, title: b.title, order: count + 1 }).returning();
          await notify(await courseStudentIds(courseId), "content", `New content: ${b.title}`);
          return json({ module: m }, 201);
        }
      }

      if (seg[2] === "discussions") {
        await assertCourseMember(u, courseId);
        if (method === "GET") {
          const rows = await db.select({
            id: schema.discussions.id, title: schema.discussions.title, body: schema.discussions.body,
            createdAt: schema.discussions.createdAt, authorName: schema.users.name, authorId: schema.discussions.authorId,
            replyCount: sql<number>`(select count(*)::int from ${schema.discussionReplies} r where r.discussion_id = ${schema.discussions.id})`
          }).from(schema.discussions)
            .innerJoin(schema.users, eq(schema.users.id, schema.discussions.authorId))
            .where(eq(schema.discussions.courseId, courseId))
            .orderBy(desc(schema.discussions.createdAt));
          return json({ discussions: rows });
        }
        if (method === "POST") {
          const b = await readJson<{ title: string; body?: string }>(req);
          if (!b.title) throw new HttpError(400, "title required");
          const [d] = await db.insert(schema.discussions)
            .values({ courseId, authorId: u.id, title: b.title, body: b.body ?? "" }).returning();
          const targets = [...await courseStudentIds(courseId)];
          const [c] = await db.select().from(schema.courses).where(eq(schema.courses.id, courseId));
          if (c) targets.push(c.instructorId);
          await notify(targets.filter(id => id !== u.id), "thread", `New discussion: ${b.title}`);
          return json({ discussion: d }, 201);
        }
      }

      if (seg[2] === "attendance") {
        await assertCourseMember(u, courseId);
        if (method === "GET") {
          const rows = await db.select().from(schema.attendanceSessions)
            .where(eq(schema.attendanceSessions.courseId, courseId)).orderBy(desc(schema.attendanceSessions.date));
          if (u.role === "student") {
            return json({ sessions: rows.map(s => ({ id: s.id, date: s.date, status: s.records[u.id] ?? "absent" })) });
          }
          return json({ sessions: rows });
        }
        if (method === "POST") {
          await assertCourseInstructor(u, courseId);
          const b = await readJson<{ date: string; records: Record<string, "present" | "absent" | "late" | "excused"> }>(req);
          if (!b.date || !b.records) throw new HttpError(400, "date and records required");
          const [s] = await db.insert(schema.attendanceSessions)
            .values({ courseId, date: b.date, records: b.records })
            .onConflictDoUpdate({
              target: [schema.attendanceSessions.courseId, schema.attendanceSessions.date],
              set: { records: b.records }
            }).returning();
          return json({ session: s }, 201);
        }
      }
      throw new HttpError(404, "Unknown courses route");
    }

    /* ---------- ASSIGNMENTS (by id) ---------- */
    if (seg[0] === "assignments" && seg[1]) {
      const u = await requireUser(req);
      const assignmentId = seg[1];
      const [a] = await db.select().from(schema.assignments).where(eq(schema.assignments.id, assignmentId));
      if (!a) throw new HttpError(404, "Assignment not found");
      await assertCourseMember(u, a.courseId);

      if (seg[2] === "extend" && method === "POST") {
        await assertCourseInstructor(u, a.courseId);
        const b = await readJson<{ closeDate: string; studentId?: string }>(req);
        if (!b.closeDate) throw new HttpError(400, "closeDate required");
        await db.insert(schema.assignmentExtensions)
          .values({ assignmentId, closeDate: b.closeDate, studentId: b.studentId ?? null });
        const targets = b.studentId ? [b.studentId] : await courseStudentIds(a.courseId);
        await notify(targets, "extension", `Deadline extended: ${a.title}`);
        return json({ ok: true });
      }

      if (seg[2] === "submissions") {
        if (method === "GET") {
          if (u.role === "instructor") {
            await assertCourseInstructor(u, a.courseId);
            const rows = await db.select({
              sub: schema.submissions, studentName: schema.users.name
            }).from(schema.submissions)
              .innerJoin(schema.users, eq(schema.users.id, schema.submissions.studentId))
              .where(eq(schema.submissions.assignmentId, assignmentId))
              .orderBy(desc(schema.submissions.submittedAt));
            return json({ submissions: rows.map(r => ({ ...r.sub, studentName: r.studentName })) });
          }
          const rows = await db.select().from(schema.submissions)
            .where(and(eq(schema.submissions.assignmentId, assignmentId), eq(schema.submissions.studentId, u.id)))
            .orderBy(desc(schema.submissions.version));
          return json({ submissions: rows, effectiveDeadline: await effectiveDeadline(assignmentId, u.id) });
        }
        if (method === "POST") {
          if (u.role !== "student") throw new HttpError(403, "Students only");
          const deadline = await effectiveDeadline(assignmentId, u.id);
          if (new Date() > new Date(deadline)) throw new HttpError(423, "Submission is locked — deadline passed");
          const b = await readJson<{ files: { name: string; type: string; base64: string }[]; textAnswer?: string }>(req);
          if (!b.files?.length && !b.textAnswer) throw new HttpError(400, "files or textAnswer required");
          const store = blobStore();
          const stored: SubmissionFile[] = [];
          for (const f of (b.files ?? []).slice(0, 5)) {
            const buf = Buffer.from(f.base64, "base64");
            if (buf.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, `File ${f.name} exceeds ${MAX_UPLOAD_BYTES / 1048576}MB limit`);
            const blobKey = `${assignmentId}/${u.id}/${Date.now()}-${f.name.replace(/[^\w.\-\u0600-\u06FF]/g, "_")}`;
            await store.set(blobKey, buf.buffer as ArrayBuffer, { metadata: { type: f.type } });
            stored.push({ name: f.name, type: f.type, size: buf.byteLength, blobKey });
          }
          const prev = await db.select({ v: schema.submissions.version }).from(schema.submissions)
            .where(and(eq(schema.submissions.assignmentId, assignmentId), eq(schema.submissions.studentId, u.id)))
            .orderBy(desc(schema.submissions.version)).limit(1);
          const [s] = await db.insert(schema.submissions).values({
            assignmentId, studentId: u.id, files: stored, textAnswer: b.textAnswer ?? "",
            version: (prev[0]?.v ?? 0) + 1, isLate: false
          }).returning();
          return json({ submission: s }, 201);
        }
      }
      throw new HttpError(404, "Unknown assignments route");
    }

    /* ---------- SUBMISSIONS (grade / download) ---------- */
    if (seg[0] === "submissions" && seg[1]) {
      const u = await requireUser(req);
      const [s] = await db.select().from(schema.submissions).where(eq(schema.submissions.id, seg[1]));
      if (!s) throw new HttpError(404, "Submission not found");
      const [a] = await db.select().from(schema.assignments).where(eq(schema.assignments.id, s.assignmentId));
      if (!a) throw new HttpError(404, "Assignment not found");

      if (seg[2] === "grade" && method === "POST") {
        await assertCourseInstructor(u, a.courseId);
        const b = await readJson<{ grade: number; feedback?: string }>(req);
        if (typeof b.grade !== "number" || b.grade < 0 || b.grade > a.maxGrade) throw new HttpError(400, `grade must be 0–${a.maxGrade}`);
        const [updated] = await db.update(schema.submissions)
          .set({ grade: b.grade, feedback: b.feedback ?? "" })
          .where(eq(schema.submissions.id, s.id)).returning();
        await notify([s.studentId], "grade", `Grade released: ${a.title}`);
        return json({ submission: updated });
      }

      if (seg[2] === "file" && seg[3] !== undefined && method === "GET") {
        const isOwner = s.studentId === u.id;
        if (!isOwner) await assertCourseInstructor(u, a.courseId);
        const f = s.files[Number(seg[3])];
        if (!f) throw new HttpError(404, "File not found");
        const blob = await blobStore().get(f.blobKey, { type: "arrayBuffer" });
        if (!blob) throw new HttpError(404, "File content missing");
        return new Response(blob, {
          headers: {
            "content-type": f.type || "application/octet-stream",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`
          }
        });
      }
      throw new HttpError(404, "Unknown submissions route");
    }

    /* ---------- EXAMS (by id) ---------- */
    if (seg[0] === "exams" && seg[1]) {
      const u = await requireUser(req);
      const examId = seg[1];
      const [e] = await db.select().from(schema.exams).where(eq(schema.exams.id, examId));
      if (!e) throw new HttpError(404, "Exam not found");
      await assertCourseMember(u, e.courseId);

      if (seg[2] === "questions" && method === "PUT") {
        await assertCourseInstructor(u, e.courseId);
        const b = await readJson<{ questions: ExamQuestion[] }>(req);
        if (!Array.isArray(b.questions)) throw new HttpError(400, "questions array required");
        const [updated] = await db.update(schema.exams)
          .set({ questions: b.questions }).where(eq(schema.exams.id, examId)).returning();
        return json({ exam: updated });
      }

      if (seg[2] === "attempt" && method === "POST") {
        if (u.role !== "student") throw new HttpError(403, "Students only");
        const now = new Date();
        if (now < new Date(e.availabilityStart) || now > new Date(e.availabilityEnd))
          throw new HttpError(423, "Exam is not available");
        const existing = await db.select().from(schema.examAttempts)
          .where(and(eq(schema.examAttempts.examId, examId), eq(schema.examAttempts.studentId, u.id)));
        if (existing[0]?.isSubmitted) throw new HttpError(409, "Already submitted");
        const attempt = existing[0] ?? (await db.insert(schema.examAttempts)
          .values({ examId, studentId: u.id }).returning())[0];
        return json({ attempt, questions: sanitizeQuestions(e.questions), durationMinutes: e.durationMinutes });
      }
      throw new HttpError(404, "Unknown exams route");
    }

    /* ---------- ATTEMPTS (autosave / submit) ---------- */
    if (seg[0] === "attempts" && seg[1]) {
      const u = await requireUser(req);
      const [att] = await db.select().from(schema.examAttempts).where(eq(schema.examAttempts.id, seg[1]));
      if (!att || att.studentId !== u.id) throw new HttpError(404, "Attempt not found");
      const [e] = await db.select().from(schema.exams).where(eq(schema.exams.id, att.examId));
      if (!e) throw new HttpError(404, "Exam not found");

      const timeUp = () =>
        Date.now() > new Date(att.startedAt).getTime() + (e.durationMinutes + 1) * 60000; // 1 min grace

      if (method === "PUT") {
        if (att.isSubmitted) throw new HttpError(409, "Already submitted");
        const b = await readJson<{ answers: { questionId: string; value: unknown }[] }>(req);
        await db.update(schema.examAttempts).set({ answers: b.answers ?? [] })
          .where(eq(schema.examAttempts.id, att.id));
        return json({ ok: true, timeUp: timeUp() });
      }

      if (seg[2] === "submit" && method === "POST") {
        if (att.isSubmitted) throw new HttpError(409, "Already submitted");
        const b = await readJson<{ answers?: { questionId: string; value: unknown }[] }>(req).catch(() => ({} as any));
        const answers: { questionId: string; value: unknown }[] = b.answers ?? att.answers;
        let score = 0;
        for (const q of e.questions) {
          const ans = answers.find((x: { questionId: string; value: unknown }) => x.questionId === q.id)?.value;
          score += gradeQuestion(q, ans);
        }
        const [updated] = await db.update(schema.examAttempts).set({
          answers, score, isSubmitted: true, submittedAt: new Date().toISOString()
        }).where(eq(schema.examAttempts.id, att.id)).returning();
        const total = e.questions.reduce((s, q) => s + q.points, 0);
        return json({ attempt: updated, total, showResults: e.showResultsImmediately });
      }
      throw new HttpError(404, "Unknown attempts route");
    }

    /* ---------- DISCUSSIONS (replies) ---------- */
    if (seg[0] === "discussions" && seg[1]) {
      const u = await requireUser(req);
      const [d] = await db.select().from(schema.discussions).where(eq(schema.discussions.id, seg[1]));
      if (!d) throw new HttpError(404, "Discussion not found");
      await assertCourseMember(u, d.courseId);

      if (seg[2] === "replies") {
        if (method === "GET") {
          const rows = await db.select({
            id: schema.discussionReplies.id, content: schema.discussionReplies.content,
            createdAt: schema.discussionReplies.createdAt, authorName: schema.users.name
          }).from(schema.discussionReplies)
            .innerJoin(schema.users, eq(schema.users.id, schema.discussionReplies.authorId))
            .where(eq(schema.discussionReplies.discussionId, d.id))
            .orderBy(asc(schema.discussionReplies.createdAt));
          return json({ replies: rows });
        }
        if (method === "POST") {
          const b = await readJson<{ content: string }>(req);
          if (!b.content) throw new HttpError(400, "content required");
          const [r] = await db.insert(schema.discussionReplies)
            .values({ discussionId: d.id, authorId: u.id, content: b.content }).returning();
          if (d.authorId !== u.id) await notify([d.authorId], "thread", `Reply: ${d.title}`);
          return json({ reply: r }, 201);
        }
      }
      throw new HttpError(404, "Unknown discussions route");
    }

    /* ---------- MODULES (items / delete) ---------- */
    if (seg[0] === "modules" && seg[1]) {
      const u = await requireUser(req);
      const [m] = await db.select().from(schema.contentModules).where(eq(schema.contentModules.id, seg[1]));
      if (!m) throw new HttpError(404, "Module not found");
      await assertCourseInstructor(u, m.courseId);

      if (method === "PUT") {
        const b = await readJson<{ items?: typeof m.items; title?: string }>(req);
        const [updated] = await db.update(schema.contentModules)
          .set({ ...(b.items ? { items: b.items } : {}), ...(b.title ? { title: b.title } : {}) })
          .where(eq(schema.contentModules.id, m.id)).returning();
        return json({ module: updated });
      }
      if (method === "DELETE") {
        await db.delete(schema.contentModules).where(eq(schema.contentModules.id, m.id));
        return json({ ok: true });
      }
      throw new HttpError(404, "Unknown modules route");
    }

    /* ---------- MESSAGES ---------- */
    if (seg[0] === "messages") {
      const u = await requireUser(req);

      if (seg[1] === "contacts" && method === "GET") {
        const ids = await myCourseIds(u);
        if (!ids.length) return json({ contacts: [] });
        let contacts: { id: string; name: string; role: string }[] = [];
        if (u.role === "student") {
          const rows = await db.select({ id: schema.users.id, name: schema.users.name, role: schema.users.role })
            .from(schema.courses)
            .innerJoin(schema.users, eq(schema.users.id, schema.courses.instructorId))
            .where(inArray(schema.courses.id, ids));
          contacts = rows;
        } else {
          const rows = await db.select({ id: schema.users.id, name: schema.users.name, role: schema.users.role })
            .from(schema.enrollments)
            .innerJoin(schema.users, eq(schema.users.id, schema.enrollments.studentId))
            .where(inArray(schema.enrollments.courseId, ids));
          contacts = rows;
        }
        const dedup = [...new Map(contacts.map(c => [c.id, c])).values()];
        const unread = await db.select({
          fromId: schema.messages.fromId, count: sql<number>`count(*)::int`
        }).from(schema.messages)
          .where(and(eq(schema.messages.toId, u.id), eq(schema.messages.read, false)))
          .groupBy(schema.messages.fromId);
        return json({
          contacts: dedup.map(c => ({ ...c, unread: unread.find(x => x.fromId === c.id)?.count ?? 0 }))
        });
      }

      if (method === "POST" && !seg[1]) {
        const b = await readJson<{ toId: string; content: string }>(req);
        if (!b.toId || !b.content) throw new HttpError(400, "toId and content required");
        const [msg] = await db.insert(schema.messages)
          .values({ fromId: u.id, toId: b.toId, content: b.content }).returning();
        await notify([b.toId], "message", "New private message");
        return json({ message: msg }, 201);
      }

      if (seg[1] && method === "GET") {
        const other = seg[1];
        const rows = await db.select().from(schema.messages).where(or(
          and(eq(schema.messages.fromId, u.id), eq(schema.messages.toId, other)),
          and(eq(schema.messages.fromId, other), eq(schema.messages.toId, u.id))
        )).orderBy(asc(schema.messages.createdAt));
        await db.update(schema.messages).set({ read: true }).where(and(
          eq(schema.messages.fromId, other), eq(schema.messages.toId, u.id), eq(schema.messages.read, false)
        ));
        return json({ messages: rows });
      }
      throw new HttpError(404, "Unknown messages route");
    }

    /* ---------- NOTIFICATIONS ---------- */
    if (seg[0] === "notifications") {
      const u = await requireUser(req);
      if (method === "GET") {
        const rows = await db.select().from(schema.notifications)
          .where(eq(schema.notifications.userId, u.id))
          .orderBy(desc(schema.notifications.createdAt)).limit(100);
        return json({ notifications: rows });
      }
      if (seg[1] === "read" && method === "POST") {
        const b = await readJson<{ ids?: string[] }>(req).catch(() => ({} as { ids?: string[] }));
        if (b.ids?.length) {
          await db.update(schema.notifications).set({ read: true })
            .where(and(eq(schema.notifications.userId, u.id), inArray(schema.notifications.id, b.ids)));
        } else {
          await db.update(schema.notifications).set({ read: true })
            .where(eq(schema.notifications.userId, u.id));
        }
        return json({ ok: true });
      }
      throw new HttpError(404, "Unknown notifications route");
    }

    /* ---------- SEED (one-time demo data; guarded by AUTH_SECRET) ---------- */
    if (seg[0] === "seed" && method === "POST") {
      if (req.headers.get("x-seed-secret") !== process.env.AUTH_SECRET) throw new HttpError(403, "Forbidden");
      const existing = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
      if (existing.length) return json({ ok: true, note: "Already seeded" });
      const [inst] = await db.insert(schema.users).values({
        role: "instructor", name: "د. أحمد الخالدي / Dr. Ahmed Al-Khalidi",
        email: "instructor@academia.hub", passwordHash: await hashPassword("ChangeMe-2026!")
      }).returning();
      const [stu] = await db.insert(schema.users).values({
        role: "student", name: "محمد العلي / Mohammed Al-Ali",
        email: "student@academia.hub", passwordHash: await hashPassword("ChangeMe-2026!"), studentId: "20240001"
      }).returning();
      const [course] = await db.insert(schema.courses).values({
        name: "مبادئ علم الأدوية الأساسية / Basic Pharmacology", code: "MED-301",
        description: "Cardiac and vascular pharmacology essentials.",
        joinCode: "MED301A", instructorId: inst.id
      }).returning();
      await db.insert(schema.enrollments).values({ courseId: course.id, studentId: stu.id });
      return json({ ok: true, demo: { instructor: inst.email, student: stu.email, password: "ChangeMe-2026!" } }, 201);
    }

    throw new HttpError(404, "Unknown route");
  } catch (e: unknown) {
    if (e instanceof HttpError) return err(e.status, e.message);
    const anyE = e as { status?: number; message?: string };
    if (anyE?.status) return err(anyE.status, anyE.message ?? "Error");
    console.error(e);
    return err(500, "Internal server error");
  }
};
