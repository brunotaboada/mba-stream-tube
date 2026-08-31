# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose ps minio` — expect status `healthy`
- **Buckets:** `docker compose ps -a minio-init` — expect `Exited (0)`; it creates `streamtube-videos` (private) and `streamtube-thumbnails` (public-read)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — video processing worker (FFmpeg); no HTTP port, consumes the `video-processing` queue
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7, port `6379`, backs the BullMQ queue
- `minio` — S3-compatible object storage, API on `9000`, console on `9001`
- `minio-init` — one-shot bucket bootstrap; exits 0 once both buckets exist
- `mailpit` — SMTP catcher, SMTP `1025`, Web UI `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker with hot-reload (runs in the video-worker service)
npm run start:worker:prod                # Run the compiled worker

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
docker compose logs video-worker
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db`, `redis` or `minio` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Storage and queue behaviour is exercised against the **real** MinIO and Redis running in Compose, not mocks — that is what makes assertions like "the presigned URL answers 206 for a ranged request" meaningful. Video fixtures are generated by FFmpeg during test setup rather than committed as binaries.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `maxWorkers: 1` in `test/jest-e2e.json` — E2E suites share one database and truncate the same tables, so running them in parallel produces foreign-key violations that look like application bugs. `npm run test:e2e` does not pass `--runInBand`, so the config must enforce it.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

### Two processes, one codebase

The image runs two entrypoints:

- **API** — `src/main.ts` boots `AppModule` and serves HTTP.
- **Worker** — `src/worker/main.ts` boots `WorkerModule` via `NestFactory.createApplicationContext` (no HTTP listener) and consumes the `video-processing` queue. It imports `ProcessingModule` and `UsersModule` — never `AppModule` — so it registers no controllers and no global guard.

Keeping FFmpeg in its own process is deliberate: transcoding multi-GB files in the API process would starve request handling. `enableShutdownHooks()` lets an in-flight job finish on SIGTERM.

Because `autoLoadEntities` only discovers entities registered by an imported module, the worker imports the modules that **own** the entities in its graph (`Video` → `Channel` → `User`) rather than re-declaring them.

## Videos

Phase 03 delivers video upload, processing and delivery.

### Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| `VideosModule` | `src/videos/` | Video entity, upload lifecycle, public retrieval, streaming and download |
| `StorageModule` | `src/storage/` | The only place that talks to the S3 SDK — multipart lifecycle, presigned URLs, object read/write |
| `QueueModule` | `src/queue/` | BullMQ connection, the `video-processing` queue and its producer |
| `ProcessingModule` | `src/videos/processing/` | FFmpeg wrapper and the job consumer; loaded by the worker, not the API |

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/videos/uploads` | Bearer | Pre-registers a `draft` and returns presigned part URLs |
| POST | `/videos/:id/uploads/complete` | Bearer (owner) | Finalises the multipart upload, moves to `processing`, enqueues the job |
| DELETE | `/videos/:id/uploads` | Bearer (owner) | Aborts the upload and discards the draft |
| GET | `/videos/:publicId` | Public | Video metadata by its 11-character public id |
| GET | `/videos/:publicId/stream` | Public | 302 to a presigned URL; storage serves `Range`/`206` |
| GET | `/videos/:publicId/download` | Public | 302 to a presigned URL with an attachment `Content-Disposition` |

### Upload strategy

Video bytes **never pass through the API**. The API signs S3 multipart part URLs and the client uploads directly to object storage. A single `PutObject` caps at 5 GiB, so multipart is required for the 10GB ceiling; at the default 100 MiB part size a 10 GiB upload is 103 parts. A failed part is retried alone rather than restarting the transfer.

Do not add an endpoint that accepts a video body — it would occupy a request handler for the whole transfer and defeat the design.

### Status lifecycle

`draft` → `processing` → `ready` | `failed`

The row is created `draft` when the upload is initiated, moves to `processing` when the upload is completed, and the worker settles it. Failures retry 3 times with exponential backoff; only after the last attempt is the row marked `failed` with the reason in `processing_error`.

The job payload is `{ videoId }` only. The consumer reloads current state, so a redelivered job can never act on a stale snapshot; the job id **is** the video id, so a duplicate enqueue collapses. The consumer returns early when the video is already `ready`, which is what makes at-least-once delivery safe.

### Buckets

- `streamtube-videos` — **private**; source files at `{videoId}/source{ext}`, reachable only through short-lived presigned URLs.
- `streamtube-thumbnails` — **public-read**; thumbnails at `{videoId}.jpg`, served as plain cacheable URLs with no signing.

Never write anything sensitive to the thumbnails bucket.

### FFmpeg

`ffprobe` and `ffmpeg` come from `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe`, which ship prebuilt binaries via npm — so the version is pinned in `package-lock.json` and the image needs no `apt-get`. Resolve the binary from the package's `.path`, never a hard-coded system path.

Both are invoked through `child_process.execFile` with an **argument array** (never a shell string, so a hostile filename cannot inject a command) and an explicit `timeout`.

### Public identifiers

`public_id` is `crypto.randomBytes(8).toString('base64url')` — 11 URL-safe characters, unique-indexed, retried on collision. `nanoid` is **not** used: from v4 it is ESM-only and this project compiles to CommonJS.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
