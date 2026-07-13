# Academia Hub — Backend (Phase 2)

Full production backend for Academia Hub:
**Netlify Functions** (API) + **Netlify DB / Neon Postgres** (Drizzle ORM) + **Netlify Blobs** (real file storage) + **JWT auth with bcrypt password hashing**.

## What this fixes vs. the static demo
| Problem in demo | Solution here |
|---|---|
| Data trapped in one browser's localStorage | Shared Postgres database |
| Plain-text passwords in the browser | bcrypt hashing + JWT (7-day) sessions |
| File uploads stored metadata only | Actual file content in Netlify Blobs, downloadable by instructor |
| Exam answer keys shipped to the student's browser | Server-side grading; questions are sanitized before reaching students |
| Deadlines enforced client-side only | Server rejects submissions past the effective deadline (HTTP 423) |

## Project structure
```
├── netlify.toml               Build & functions config
├── package.json
├── drizzle.config.ts
├── db/schema.ts               All 15 tables (users → notifications)
├── lib/
│   ├── db.ts                  Drizzle + Neon client
│   ├── auth.ts                bcrypt + JWT helpers, role guards
│   └── http.ts                JSON response helpers
├── netlify/functions/api.ts   Single router — all /api/* endpoints
└── public/
    ├── index.html             Current SPA (still localStorage; wiring = Phase 2b)
    └── api-client.js          Drop-in fetch service layer (API.login, API.courses, ...)
```

## Setup (one time)

1. **Push to GitHub**: create a repo (e.g. `academia-hub`) and push this folder.
2. **Link to Netlify**: in app.netlify.com open your project `academia-hub-zcz` →
   *Project configuration → Build & deploy → Link repository* and select the repo.
   (Or create a fresh project with "Import an existing project".)
3. **Provision the database**: in the project, go to **Extensions → Neon database** and install it
   (or run `netlify db init` locally). This injects `NETLIFY_DATABASE_URL` automatically.
4. **Set the auth secret**: *Project configuration → Environment variables* → add
   `AUTH_SECRET` = a long random string (e.g. output of `openssl rand -hex 32`).
5. **Create the tables** — locally:
   ```bash
   npm install
   netlify link            # link folder to the Netlify project
   netlify env:get NETLIFY_DATABASE_URL   # confirm it exists
   npx netlify dev:exec -- npm run db:push   # or: NETLIFY_DATABASE_URL=... npm run db:push
   ```
6. **Deploy**: push to the repo — Netlify builds and deploys automatically.
7. *(Optional)* **Seed demo data**:
   ```bash
   curl -X POST https://YOUR-SITE.netlify.app/api/seed -H "x-seed-secret: $AUTH_SECRET"
   ```
   Creates the demo instructor/student (password `ChangeMe-2026!`) and course MED-301.

## API overview (all under `/api`, JSON, `Authorization: Bearer <token>`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` |
| Courses | `GET/POST /courses`, `POST /courses/join`, `GET /courses/:id/people`, `DELETE /courses/:id/students/:sid` |
| Announcements | `GET/POST /courses/:id/announcements` |
| Assignments | `GET/POST /courses/:id/assignments`, `POST /assignments/:id/extend` |
| Submissions | `GET/POST /assignments/:id/submissions` (files as base64, ≤4 MB each), `POST /submissions/:id/grade`, `GET /submissions/:id/file/:index` |
| Exams | `GET/POST /courses/:id/exams`, `PUT /exams/:id/questions`, `POST /exams/:id/attempt`, `PUT /attempts/:id`, `POST /attempts/:id/submit` |
| Content | `GET/POST /courses/:id/modules`, `PUT/DELETE /modules/:id` |
| Discussions | `GET/POST /courses/:id/discussions`, `GET/POST /discussions/:id/replies` |
| Messages | `GET /messages/contacts`, `GET /messages/:userId`, `POST /messages` |
| Attendance | `GET/POST /courses/:id/attendance` |
| Notifications | `GET /notifications`, `POST /notifications/read` |

## Security notes
- Passwords: bcrypt (cost 10), minimum 8 characters.
- Sessions: HS256 JWT, 7-day expiry, secret from `AUTH_SECRET`.
- Authorization enforced per route: course membership for reads, instructor-of-course for writes.
- Students never receive `correctAnswer`/`tolerance` fields; grading happens server-side with a 1-minute grace period on the exam timer.
- Join codes are hidden from student responses.

## Phase 2b (next step)
`public/index.html` still runs on localStorage. The wiring step replaces the
"State & Mock API" section with calls to `api-client.js` (method names already
match the app's actions: `API.login`, `API.courses`, `API.submit`, `API.saveQuestions`, ...).
