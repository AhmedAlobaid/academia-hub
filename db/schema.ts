import {
  pgTable, uuid, text, real, integer, boolean, timestamp, jsonb, unique
} from "drizzle-orm/pg-core";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

/* ---------- Users ---------- */
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  role: text("role").notNull(), // 'instructor' | 'student'
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  studentId: text("student_id"),
  createdAt: ts("created_at").defaultNow().notNull()
});

/* ---------- Courses & Enrollments ---------- */
export const courses = pgTable("courses", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  description: text("description").default(""),
  coverColor: text("cover_color").default("#1E3A5F"),
  joinCode: text("join_code").notNull().unique(),
  instructorId: uuid("instructor_id").notNull().references(() => users.id),
  createdAt: ts("created_at").defaultNow().notNull()
});

export const enrollments = pgTable("enrollments", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  enrolledAt: ts("enrolled_at").defaultNow().notNull()
}, (t) => [unique().on(t.courseId, t.studentId)]);

/* ---------- Assignments ---------- */
export const assignments = pgTable("assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  instructions: text("instructions").default(""),
  attachments: jsonb("attachments").$type<{ name: string; type: string; size: number }[]>().default([]),
  maxGrade: real("max_grade").notNull().default(10),
  openDate: ts("open_date"),
  closeDate: ts("close_date").notNull(),
  allowedFormats: jsonb("allowed_formats").$type<string[]>().default(["pdf", "docx", "pptx", "zip", "jpg", "png"]),
  maxFileSizeMb: integer("max_file_size_mb").default(20),
  createdAt: ts("created_at").defaultNow().notNull()
});

export const assignmentExtensions = pgTable("assignment_extensions", {
  id: uuid("id").defaultRandom().primaryKey(),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").references(() => users.id, { onDelete: "cascade" }), // null = global extension
  closeDate: ts("close_date").notNull(),
  createdAt: ts("created_at").defaultNow().notNull()
});

/* ---------- Submissions (files live in Netlify Blobs) ---------- */
export type SubmissionFile = { name: string; type: string; size: number; blobKey: string };

export const submissions = pgTable("submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  files: jsonb("files").$type<SubmissionFile[]>().notNull().default([]),
  textAnswer: text("text_answer").default(""),
  submittedAt: ts("submitted_at").defaultNow().notNull(),
  version: integer("version").notNull().default(1),
  grade: real("grade"),
  feedback: text("feedback").default(""),
  isLate: boolean("is_late").notNull().default(false)
});

/* ---------- Exams ---------- */
export type ExamQuestion = {
  id: string;
  type: "single" | "truefalse" | "short" | "essay";
  text: string;
  points: number;
  options?: { id: string; text: string }[];
  correctAnswer?: string | boolean;
  tolerance?: "low";
};

export const exams = pgTable("exams", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  instructions: text("instructions").default(""),
  availabilityStart: ts("availability_start").notNull(),
  availabilityEnd: ts("availability_end").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  questions: jsonb("questions").$type<ExamQuestion[]>().notNull().default([]),
  showResultsImmediately: boolean("show_results_immediately").notNull().default(true),
  createdAt: ts("created_at").defaultNow().notNull()
});

export const examAttempts = pgTable("exam_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  examId: uuid("exam_id").notNull().references(() => exams.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  startedAt: ts("started_at").defaultNow().notNull(),
  submittedAt: ts("submitted_at"),
  answers: jsonb("answers").$type<{ questionId: string; value: unknown }[]>().notNull().default([]),
  score: real("score"),
  isSubmitted: boolean("is_submitted").notNull().default(false)
}, (t) => [unique().on(t.examId, t.studentId)]);

/* ---------- Announcements ---------- */
export const announcements = pgTable("announcements", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  createdAt: ts("created_at").defaultNow().notNull()
});

export const announcementComments = pgTable("announcement_comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  announcementId: uuid("announcement_id").notNull().references(() => announcements.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  createdAt: ts("created_at").defaultNow().notNull()
});

/* ---------- Course Content Modules ---------- */
export type ContentItem = {
  id: string;
  type: "video" | "file" | "link" | "text";
  title: string;
  url?: string;
  fileName?: string;
  size?: number;
  content?: string;
};

export const contentModules = pgTable("content_modules", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  order: integer("order").notNull().default(1),
  items: jsonb("items").$type<ContentItem[]>().notNull().default([]),
  createdAt: ts("created_at").defaultNow().notNull()
});

/* ---------- Discussions ---------- */
export const discussions = pgTable("discussions", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  body: text("body").default(""),
  createdAt: ts("created_at").defaultNow().notNull()
});

export const discussionReplies = pgTable("discussion_replies", {
  id: uuid("id").defaultRandom().primaryKey(),
  discussionId: uuid("discussion_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  createdAt: ts("created_at").defaultNow().notNull()
});

/* ---------- Private Messages ---------- */
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  fromId: uuid("from_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  toId: uuid("to_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: ts("created_at").defaultNow().notNull()
});

/* ---------- Attendance ---------- */
export const attendanceSessions = pgTable("attendance_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  courseId: uuid("course_id").notNull().references(() => courses.id, { onDelete: "cascade" }),
  date: text("date").notNull(), // YYYY-MM-DD
  records: jsonb("records").$type<Record<string, "present" | "absent" | "late" | "excused">>().notNull().default({}),
  createdAt: ts("created_at").defaultNow().notNull()
}, (t) => [unique().on(t.courseId, t.date)]);

/* ---------- Notifications ---------- */
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  message: text("message").notNull(),
  read: boolean("read").notNull().default(false),
  createdAt: ts("created_at").defaultNow().notNull()
});
