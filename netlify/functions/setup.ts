import type { Config } from "@netlify/functions";
import { neon } from "@neondatabase/serverless";

export const config: Config = { path: "/db-setup" };

/**
 * One-time database setup — creates all tables.
 * Open in a browser:  /db-setup?secret=YOUR_AUTH_SECRET
 * Safe to run twice: every statement uses IF NOT EXISTS.
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");

  if (!process.env.AUTH_SECRET) {
    return html("❌ AUTH_SECRET is not set", "Add it in Project configuration → Environment variables.", false);
  }
  if (secret !== process.env.AUTH_SECRET) {
    return html("❌ Wrong or missing secret", "Open this page as /db-setup?secret=YOUR_AUTH_SECRET", false, 403);
  }
  if (!process.env.NETLIFY_DATABASE_URL) {
    return html("❌ No database connected", "Create the database in the Database tab, then redeploy.", false);
  }

  const sql = neon(process.env.NETLIFY_DATABASE_URL);

  const statements: [string, string][] = [
    ["users", `create table if not exists users (
      id uuid primary key default gen_random_uuid(),
      role text not null,
      name text not null,
      email text not null unique,
      password_hash text not null,
      student_id text,
      created_at timestamptz not null default now()
    )`],
    ["courses", `create table if not exists courses (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      code text not null,
      description text default '',
      cover_color text default '#1E3A5F',
      join_code text not null unique,
      instructor_id uuid not null references users(id),
      created_at timestamptz not null default now()
    )`],
    ["enrollments", `create table if not exists enrollments (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      student_id uuid not null references users(id) on delete cascade,
      enrolled_at timestamptz not null default now(),
      unique (course_id, student_id)
    )`],
    ["assignments", `create table if not exists assignments (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      title text not null,
      instructions text default '',
      attachments jsonb default '[]'::jsonb,
      max_grade real not null default 10,
      open_date timestamptz,
      close_date timestamptz not null,
      allowed_formats jsonb default '["pdf","docx","pptx","zip","jpg","png"]'::jsonb,
      max_file_size_mb integer default 20,
      created_at timestamptz not null default now()
    )`],
    ["assignment_extensions", `create table if not exists assignment_extensions (
      id uuid primary key default gen_random_uuid(),
      assignment_id uuid not null references assignments(id) on delete cascade,
      student_id uuid references users(id) on delete cascade,
      close_date timestamptz not null,
      created_at timestamptz not null default now()
    )`],
    ["submissions", `create table if not exists submissions (
      id uuid primary key default gen_random_uuid(),
      assignment_id uuid not null references assignments(id) on delete cascade,
      student_id uuid not null references users(id) on delete cascade,
      files jsonb not null default '[]'::jsonb,
      text_answer text default '',
      submitted_at timestamptz not null default now(),
      version integer not null default 1,
      grade real,
      feedback text default '',
      is_late boolean not null default false
    )`],
    ["exams", `create table if not exists exams (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      title text not null,
      instructions text default '',
      availability_start timestamptz not null,
      availability_end timestamptz not null,
      duration_minutes integer not null,
      questions jsonb not null default '[]'::jsonb,
      show_results_immediately boolean not null default true,
      created_at timestamptz not null default now()
    )`],
    ["exam_attempts", `create table if not exists exam_attempts (
      id uuid primary key default gen_random_uuid(),
      exam_id uuid not null references exams(id) on delete cascade,
      student_id uuid not null references users(id) on delete cascade,
      started_at timestamptz not null default now(),
      submitted_at timestamptz,
      answers jsonb not null default '[]'::jsonb,
      score real,
      is_submitted boolean not null default false,
      unique (exam_id, student_id)
    )`],
    ["announcements", `create table if not exists announcements (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      author_id uuid not null references users(id),
      content text not null,
      created_at timestamptz not null default now()
    )`],
    ["announcement_comments", `create table if not exists announcement_comments (
      id uuid primary key default gen_random_uuid(),
      announcement_id uuid not null references announcements(id) on delete cascade,
      author_id uuid not null references users(id),
      content text not null,
      created_at timestamptz not null default now()
    )`],
    ["content_modules", `create table if not exists content_modules (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      title text not null,
      "order" integer not null default 1,
      items jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    )`],
    ["discussions", `create table if not exists discussions (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      author_id uuid not null references users(id),
      title text not null,
      body text default '',
      created_at timestamptz not null default now()
    )`],
    ["discussion_replies", `create table if not exists discussion_replies (
      id uuid primary key default gen_random_uuid(),
      discussion_id uuid not null references discussions(id) on delete cascade,
      author_id uuid not null references users(id),
      content text not null,
      created_at timestamptz not null default now()
    )`],
    ["messages", `create table if not exists messages (
      id uuid primary key default gen_random_uuid(),
      from_id uuid not null references users(id) on delete cascade,
      to_id uuid not null references users(id) on delete cascade,
      content text not null,
      read boolean not null default false,
      created_at timestamptz not null default now()
    )`],
    ["attendance_sessions", `create table if not exists attendance_sessions (
      id uuid primary key default gen_random_uuid(),
      course_id uuid not null references courses(id) on delete cascade,
      date text not null,
      records jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique (course_id, date)
    )`],
    ["notifications", `create table if not exists notifications (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      type text not null,
      message text not null,
      read boolean not null default false,
      created_at timestamptz not null default now()
    )`]
  ];

  const created: string[] = [];
  try {
    for (const [name, stmt] of statements) {
      await sql(stmt);
      created.push(name);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return html("❌ Setup failed", `Created ${created.length}/${statements.length} tables.<br>Error: ${escapeHtml(msg)}`, false, 500);
  }

  return html(
    "✅ Database ready",
    `${created.length} tables created:<br><code>${created.join(", ")}</code>
     <br><br><b>Next step:</b> open
     <a href="/db-seed?secret=${encodeURIComponent(secret)}">/db-seed?secret=…</a>
     to create the demo accounts.`,
    true
  );
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function html(title: string, body: string, ok: boolean, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <title>${escapeHtml(title)}</title>
     <div style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:32px;
                 border:1px solid #E5E7EB;border-radius:12px;line-height:1.7;">
       <h1 style="color:${ok ? "#059669" : "#DC2626"};margin:0 0 12px;">${escapeHtml(title)}</h1>
       <div style="color:#374151;">${body}</div>
     </div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
