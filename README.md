# SphereX LMS — Backend

Express + TypeScript + PostgreSQL backend that replaces Supabase for the SphereX LMS client.

## Stack

- **Express 4** with strict TypeScript
- **PostgreSQL** via `pg` (no ORM — plain SQL with parameterised queries)
- **JWT** sessions stored in an HTTP-only cookie (also accepts `Authorization: Bearer ...`)
- **bcryptjs** for password hashing
- **zod** for request validation
- **multer** for file upload, `helmet`, `cors`, `compression`, `morgan`, `cookie-parser`
- **Bunny.net** proxy routes ported from the client

## Getting started

### 1. Install dependencies

```bash
cd lms-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env`:

| Var | Notes |
|---|---|
| `DATABASE_URL` | e.g. `postgresql://postgres:postgres@localhost:5432/spherex_lms` |
| `JWT_SECRET` | A long random string; rotate to invalidate all sessions |
| `CLIENT_ORIGIN` | The Next.js dev URL, default `http://localhost:3000` |
| `COOKIE_SECURE` | `true` in production behind HTTPS |
| `BUNNY_*` | Move these from `lms-client/.env.local` to here |

### 3. Create the database

In `psql` or any Postgres client:

```sql
CREATE DATABASE spherex_lms;
```

### 4. Apply schema and seed

```bash
npm run db:migrate
npm run db:seed
```

The seed creates an admin: `admin@spherex.local` / `Admin123!` and three sample courses.

### 5. Run

```bash
npm run dev          # tsx watch on src/index.ts
# or
npm run build && npm start
```

Default URL: `http://localhost:4000`. Health check: `GET /health`.

## API

All routes are mounted under `/api`. JSON bodies. Auth via cookie `spherex_session` or `Authorization: Bearer <jwt>`.

### Auth — `/api/auth`

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/register` | `{ email, password, full_name?, name? }` | Returns `{ user, token }`, sets cookie |
| POST | `/login` | `{ email, password }` | Returns `{ user, token }`, sets cookie |
| POST | `/logout` | — | Clears cookie |
| GET  | `/me` | — | Returns current user (auth required) |

### Users — `/api/users` (admin for list/delete)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | List users with `enrollment_count` (admin) |
| GET | `/:id` | Self or admin |
| PATCH | `/:id` | Self for `full_name`/`name`; admin for `role`/`status` |
| DELETE | `/:id` | Admin |

### Courses — `/api/courses`

| Method | Path | Notes |
|---|---|---|
| GET | `/?category=&level=&search=` | Auth |
| GET | `/:id` | Auth |
| POST | `/` | Admin |
| PATCH | `/:id` | Admin |
| DELETE | `/:id` | Admin |

### Enrollments — `/api/enrollments`

| Method | Path | Notes |
|---|---|---|
| GET | `/?user_id=&completed=&include=course` | Defaults to current user |
| POST | `/` body `{ course_id }` | Auth |
| PATCH | `/:id` body `{ progress_percent?, completed? }` | Self or admin |
| DELETE | `/:id` | Admin |

### Materials — `/api/materials`

| Method | Path | Notes |
|---|---|---|
| GET | `/?type=&search=` | Auth |
| GET | `/:id` | Auth |
| POST | `/` | Admin |
| PATCH | `/:id` | Admin |
| DELETE | `/:id` | Admin |

### Certificates — `/api/certificates`

| Method | Path | Notes |
|---|---|---|
| GET | `/?user_id=` | Self or admin |
| POST | `/` | Admin |
| DELETE | `/:id` | Admin |

### Training — `/api/training`

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Auth |
| POST | `/` | Admin |
| PATCH | `/:id` | Admin |
| DELETE | `/:id` | Admin |

### Bunny.net — `/api/bunny`

| Method | Path | Notes |
|---|---|---|
| POST | `/upload` | Multipart `file` + `path` (admin) |
| POST | `/signed-url` | Body `{ filePath, materialId?, courseId? }` (auth, enrollment-gated for non-admin if `courseId` present) |

## Migrating the Next.js client

In `lms-client`, replace each Supabase call with a call to `${NEXT_PUBLIC_API_URL}/api/...` using `fetch` with `credentials: "include"` so the session cookie travels.

A minimal client helper might look like:

```ts
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
}
```

Replace `supabase.auth.signInWithPassword` with `POST /api/auth/login`, `supabase.auth.signOut` with `POST /api/auth/logout`, `supabase.auth.getUser` with `GET /api/auth/me`. Replace `supabase.from('courses').select(...)` with `GET /api/courses`, etc.

## Project layout

```
src/
  app.ts                     Express app factory
  index.ts                   Entry point
  config/
    env.ts                   Environment loading + validation
    db.ts                    pg Pool + helpers
  db/
    schema.sql               Idempotent schema
    migrate.ts               Run schema.sql
    seed.ts                  Create admin + sample courses
  middleware/
    auth.ts                  attachUser / requireAuth / requireAdmin
    error.ts                 notFound + central error handler
    validate.ts              zod -> 400 with details
  modules/
    auth/                    register, login, logout, me
    users/                   list, get, update, delete
    courses/                 CRUD
    enrollments/             list, create, update progress, delete
    materials/               CRUD
    certificates/            list, create, delete
    training/                CRUD
    bunny/                   upload + signed-url
  utils/
    asyncHandler.ts
    httpError.ts
    jwt.ts
    password.ts
```

## Notes on the migration from Supabase

- The Supabase `auth.users.id` does not transfer automatically. Either re-register users via `/api/auth/register`, or write a one-off script that copies rows from a Supabase dump into the new `users` table (preserving UUIDs is fine; you'll just need fresh `password_hash` values since Supabase stores hashes you can't reuse directly).
- The client previously read `users.full_name` with a fallback to `users.name`. Both columns are preserved here.
- `enrolled_count` on `courses` is now maintained transactionally by the enrollments endpoints, so it stays accurate without a recompute job.
- Bunny credentials should now live only in `lms-server/.env`. Remove them from `lms-client/.env.local`.
