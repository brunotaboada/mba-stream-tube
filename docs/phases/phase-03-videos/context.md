---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-30T23:43:11+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T01:18:04+00:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-08-30T23:43:11+00:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-08-30T23:43:11+00:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-08-30T23:43:11+00:00"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-08-30T23:43:11+00:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, categorias, visibilidade pública/unlisted, fluxo de rascunho → publicação e painel de gerenciamento (Fase 04). Página de visualização e player (Fase 05). Likes, comentários e inscrições (Fase 06). Busca e home (Fase 07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video upload and playback screens belong to Fase 04 and Fase 05. No UI surface is built in this phase.

**Sequencing notes:** Depends on Fase 01 (configuração base) and Fase 02 (autenticação e canais). Videos belong to a channel, and every mutating endpoint is authenticated by the JWT guard established in Fase 02.

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | bullmq@^6.x, @nestjs/bullmq@^11.0.5, ioredis (transitive) |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object Storage Layout | decided | B (two buckets — private videos, public thumbnails) | @aws-sdk/client-s3@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Large-File Upload Strategy (10GB) | decided | C (S3 multipart with presigned part URLs) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Upload Lifecycle Signals | decided | A (explicit complete + abort endpoints) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Worker Runtime Topology | decided | B (separate Nest standalone app, own container) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Repo-wide | FFmpeg Provisioning | decided | B (static binaries via npm) | @ffmpeg-installer/ffmpeg@^1.1.0, @ffprobe-installer/ffprobe@^2.1.2 |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | FFmpeg Invocation Binding | decided | B (direct `child_process.execFile`) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Thumbnail Frame Selection | decided | B (10% of duration, floored at 1s) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Unique Public URL Identifier | decided | C (`crypto.randomBytes(8)` base64url) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Video Streaming Delivery | decided | B (302 to short-lived presigned GET) | @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Video Download Delivery | decided | B (302 with `response-content-disposition`) | @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-12 | technical-decisions-phase-03-videos.md | Backend | Status Lifecycle & Failure Handling | decided | A (`draft`→`processing`→`ready`\|`failed`) | — |
| phase-03-videos/TD-13 | technical-decisions-phase-03-videos.md | Backend | Job Payload Contract | decided | B (thin `{ videoId }`, idempotent) | — |
| phase-03-videos/TD-14 | technical-decisions-phase-03-videos.md | Backend | Metadata Persistence Shape | decided | C (discrete columns + raw `jsonb`) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05, phase-03-videos/TD-13 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-12, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-09 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-10 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — the only option that gives durable retries, backoff, concurrency control and stalled-job recovery as configuration rather than code, while adding a single lightweight container that runs identically in Compose and in production. RabbitMQ's extra guarantees buy nothing for a single-producer/single-consumer topology, and pg-boss's atomicity is outweighed by putting multi-GB FFmpeg job churn on the primary database. The dual-write risk is mitigated by TD-12's reconciliation rule.

**Libraries:** `bullmq@^6.x`, `@nestjs/bullmq@^11.0.5`

### phase-03-videos/TD-02

**Recommendation:** Two buckets — the access policies of source videos and thumbnails genuinely differ, and encoding that difference at the bucket boundary lets thumbnails be served as cheap public URLs while source media stays signed-only. Keys are `{videoId}/source{ext}` in the videos bucket and `{videoId}.jpg` in the thumbnails bucket. Bucket names come from configuration so production can point at real S3 buckets.

**Libraries:** `@aws-sdk/client-s3@^3.x`

### phase-03-videos/TD-03

**Recommendation:** S3 multipart upload with presigned part URLs — the only candidate that satisfies the 10GB ceiling and the resumability requirement while keeping the API completely out of the data path. Part size is configurable with a default of 100 MiB (10GB → ~100 parts, inside the 10,000-part cap) and the API rejects declared sizes above the configured maximum before signing anything.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Explicit completion endpoint plus explicit abort endpoint — makes the API the authority on whether the object is complete, keeps behaviour identical across MinIO and S3, and puts the status transition and the enqueue in a single testable server-side action. Abandonment is handled by TD-12's reconciliation rule.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Separate Nest standalone application in the same codebase — delivers the process isolation the architecture calls for while keeping a single source of truth for the entity, configuration and storage layout. The worker imports the shared modules directly, so the API↔worker contract cannot drift. Uses `NestFactory.createApplicationContext` with shutdown hooks so in-flight jobs finish on SIGTERM.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Static binaries via npm — pinning the FFmpeg version in the same lockfile as the application makes the build reproducible and lets API and worker share one image, and it removes a build-time dependency on distribution mirrors. The staleness of the bundled build is an accepted, bounded trade-off given this phase uses only `ffprobe` JSON output and single-frame extraction with `scale`.

**Libraries:** `@ffmpeg-installer/ffmpeg@^1.1.0`, `@ffprobe-installer/ffprobe@^2.1.2`

### phase-03-videos/TD-07

**Recommendation:** Direct `execFile` — the phase needs exactly two FFmpeg invocations, so a wrapper's convenience is negligible while its costs (an unmaintained dependency, weaker process control) are real. Passing arguments as an array avoids shell interpretation of attacker-influenced filenames, and explicit `timeout` bounds protect the worker from a malformed file that makes FFmpeg hang.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** 10% of duration with a 1s floor — uses the duration already extracted, behaves sensibly across the full range of video lengths, and stays deterministic enough to assert precisely in tests. Frame scaled to 1280px wide (`scale=1280:-2`), JPEG quality 2, input-side `-ss` seek so cost is independent of file size.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** `crypto.randomBytes(8).toString('base64url')` — matches `nanoid`'s length and entropy using only the standard library, sidestepping the ESM/CommonJS incompatibility that makes `nanoid` awkward in this CommonJS project, and its cryptographic randomness makes identifiers unguessable ahead of the unlisted visibility feature in Fase 04. Stored in a unique-indexed `public_id` column with retry on unique violation.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Redirect to a short-lived presigned GET URL — delegates `Range`/`206` to the storage engine that implements it natively, keeps the API's cost independent of how much video is watched, and follows the architecture the project already documents, while still running an authorisation and status check on every request.

**Libraries:** `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-11

**Recommendation:** Presigned GET with response-header overrides — keeps whole-file transfers out of the API and reuses the same signing helper as TD-10, while the signed `response-content-disposition` guarantees a correct, tamper-proof download filename.

**Libraries:** `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-12

**Recommendation:** Four states (`draft` → `processing` → `ready` | `failed`) — they match the brief exactly and each transition has exactly one cause. Retries are bounded (3 attempts, exponential backoff) so a corrupt file terminates in `failed` with a stored reason. A video left in `processing` beyond a configured threshold is reconcilable and may be re-enqueued, which is safe because the job is idempotent.

**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** Thin payload `{ videoId }` — with at-least-once delivery, jobs must be safe to run more than once, and re-reading current state from the database is what makes that true. Keeps the producer/consumer contract to a single field that cannot drift as the entity evolves. Job keyed by video id so a duplicate enqueue collapses.

**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** Hybrid — duration and dimensions are needed on ordinary listing queries and deserve real columns, while retaining the raw `ffprobe` document costs little and preserves information that would otherwise require re-probing multi-GB files. The extraction step writes both in one operation.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — the documented NestJS approach; the project already uses decorators extensively. All Phase 03 request DTOs follow this.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes in a `{ statusCode, error, message }` envelope. Phase 03 adds new `DomainException` subclasses to the same filter rather than introducing a second error format.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — native NestJS integration with guard-based scoping. Already registered globally; Phase 03 upload endpoints inherit it.

**Libraries:** `@nestjs/throttler@^6.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true` and `synchronize: false`; schema changes ship as reviewed migrations in `src/database/migrations/`. _(from phase 01)_
- Docker Compose service names are the hosts for all inter-service connections — never `localhost`. _(from phase 01, enforced by `CLAUDE.md`)_
- Domain errors extend `DomainException` (`src/common/exceptions/domain.exception.ts`) carrying `errorCode` and `httpStatus`, and are rendered by the global `DomainExceptionFilter` as `{ statusCode, error, message }`. _(from phase 02)_
- A global `JwtAuthGuard` protects every route by default; anonymous routes opt out explicitly with `@Public()`. The authenticated user is read via the `@CurrentUser()` decorator. _(from phase 02)_
- Each domain feature owns its module directory under `src/`, with `TypeOrmModule.forFeature([...])` in imports and the module exporting what other modules consume. Services own their transactions via `dataSource.transaction`. _(from phase 02)_
- A service must not create or mutate entities belonging to another domain module; it delegates to that module's service (the `ChannelsModule` extraction in SI-02.15 established this). _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit, all collaborators mocked), `*.integration-spec.ts` (real DB/services, colocated with source), `*.e2e-spec.ts` (full HTTP via supertest, in `test/`). Integration and E2E run with `--runInBand`. _(from phase 02)_
- Non-TypeScript runtime assets must be declared in `nest-cli.json` under `compilerOptions.assets` or they are missing from `dist/`. _(from phase 02, SI-02.18)_

## Inherited Deferred Capabilities

| Capability | Inherited from | Status | Rationale |
|------------|----------------|--------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | delivered later | Delivered by the separate `phase-02-auth-frontend` slice once `next-frontend/` was initialized. Not a Phase 03 concern. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Telas de upload e player de vídeo | deferred | No UI surface in this phase — the video screens belong to Fase 04 (gerenciamento) and Fase 05 (visualização). The API contracts decided here are written for that future consumer. | phase-03-videos/TD-03, phase-03-videos/TD-10, phase-03-videos/TD-11 |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces the project's first external-service integrations (object storage and a message queue) and its first non-HTTP process (the worker). Per the project's testing policy, these are exercised against the real services running in Docker Compose — MinIO and Redis — rather than mocked: storage operations and queue round-trips belong in `*.integration-spec.ts`, FFmpeg wrappers are unit-tested against small generated fixtures, and the full upload → process → stream flow is covered by `*.e2e-spec.ts`. Specific layer coverage by SI is recorded in `progress.md`.
