---
kind: phase
name: phase-03-videos
test_specs_aware: false
sources_mtime:
  docs/project-plan.md: "2026-08-30T23:43:11+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T01:32:00+00:00"
  docs/phases/phase-03-videos/context.md: "2026-08-31T01:35:00+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-31T01:42:00+00:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-08-30T23:43:11+00:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video ingestion pipeline — object storage, a background processing queue, a dedicated FFmpeg worker, resumable multipart upload of files up to 10GB that never passes through the API, automatic metadata and thumbnail extraction, a short unique public URL, and streaming and download delivery — establishing the media foundation that Fase 04 (gerenciamento) and Fase 05 (visualização) build on.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install the Phase 03 dependencies, create the `storage`, `queue` and `video` config namespaces following the `registerAs` pattern inherited from Fase 01, extend the Joi schema, and add MinIO, Redis and the video worker to Docker Compose. This is the infrastructure floor every later SI stands on.

**Technical actions:**

- Install production dependencies: `bullmq@^6`, `@nestjs/bullmq@^11.0.5` (the 12.x line is ESM-only and incompatible with this CommonJS project — see `library-refs.md`), `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `@ffmpeg-installer/ffmpeg@^1.1.0`, `@ffprobe-installer/ffprobe@^2.1.2`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (default `http://minio:9000`), `STORAGE_REGION` (default `us-east-1`), `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_VIDEOS_BUCKET` (default `streamtube-videos`), `STORAGE_THUMBNAILS_BUCKET` (default `streamtube-thumbnails`), `STORAGE_PUBLIC_ENDPOINT` (default `http://localhost:9000` — the browser-reachable host used when signing URLs), `STORAGE_URL_EXPIRATION_SECONDS` (default `3600`) — per TD-02, TD-10
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) — per TD-01
- Create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_SIZE_BYTES` (default `10737418240` = 10GB), `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `104857600` = 100 MiB), `VIDEO_ALLOWED_MIME_TYPES` (comma-separated, default `video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`), `VIDEO_FFMPEG_TIMEOUT_MS` (default `300000`) — per TD-03, TD-15, TD-12
- Update `src/config/env.validation.ts` — add every new variable to the Joi schema (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` required, the rest with defaults). Update `.env.example` with Compose-compatible defaults, quoting any value containing shell-special characters per the inherited `.env` convention
- Add to `nestjs-project/compose.yaml`: a `minio` service (`minio/minio`, `server /data --console-address ":9001"`, ports 9000/9001, healthcheck on `/minio/health/live`, named volume for `/data`); a `minio-init` one-shot service using the same image's `mc` client to create both buckets idempotently and set the anonymous download policy on the thumbnails bucket (per TD-02); a `redis` service (`redis:7-alpine`, port 6379, healthcheck `redis-cli ping`); and a `video-worker` service built from the same image as `nestjs-api`, with command `npm run start:worker:dev`, depending on `db`, `redis` and `minio` being healthy
- Hosts in all environment defaults are Compose service names (`minio`, `redis`, `db`) — never `localhost` — per the inherited Docker networking rule

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` (extended) | Integration | Joi schema accepts the new variables, applies defaults, and rejects a missing `STORAGE_ACCESS_KEY` |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `minio`, `redis` and `video-worker` with all healthchecks passing
- Both buckets exist after `minio-init` completes, and the thumbnails bucket answers an anonymous object read while the videos bucket refuses one
- Starting the API without `STORAGE_ACCESS_KEY` fails at bootstrap with a Joi validation error
- The existing Phase 01/02 suites still pass unchanged

---

### SI-03.2 — Channel Lookup for Video Ownership

**Description:** Add the user→channel read path that Fase 02 never shipped, so the video module can resolve the owning channel without reaching into another domain's entities. Raised as `DG-1` by validation and decided in TD-17.

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts`, querying the `Channel` repository the module already owns
- Inject `Repository<Channel>` into `ChannelsService` alongside the existing `DataSource` (the module already registers `TypeOrmModule.forFeature([Channel])`)
- `ChannelsModule` already exports `ChannelsService`, so no module surface change is required

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` (extended) | Unit | `findByUserId` delegates to the repository with the expected criteria |
| `src/channels/channels.service.integration-spec.ts` (extended) | Integration | Returns the persisted channel for a real user, and `null` for an unknown user id |

**Dependencies:** None

**Acceptance criteria:**

- `findByUserId` returns the channel created at registration for a given user
- Returns `null` rather than throwing when the user has no channel
- No other module queries the `Channel` repository directly

---

### SI-03.3 — Video Entity, Status Enum, and Migration

**Description:** Create the `Video` entity linked to `Channel`, carrying the status lifecycle, the storage keys, the unique public identifier and the extracted metadata, and ship the migration that creates the table.

**Technical actions:**

- Create `src/videos/entities/video-status.enum.ts` — `VideoStatus` with `DRAFT = 'draft'`, `PROCESSING = 'processing'`, `READY = 'ready'`, `FAILED = 'failed'` (per TD-12)
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns specified in § Data Model below. Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`, unique index on `public_id`, and an index on `(channel_id, status)` for the Fase 04 management listing
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the emitted SQL for the enum type, the unique index and the foreign key
- Extend `src/database/migrations.integration-spec.ts` — add `videos` to `MANAGED_TABLES`, expect three migrations rather than two, and drop the `videos_status_enum` type in the cleanup step. **`DROP TABLE ... CASCADE` does not drop a PostgreSQL enum type**, so a leftover type breaks a re-run of the migration; the existing suite has this latent fragility and the new enum makes it load-bearing
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, exporting `TypeOrmModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id` constraint; `status` defaults to `draft`; FK to `channels` enforced; `metadata` round-trips as `jsonb`; nullable columns accept null before processing |
| `src/database/migrations.integration-spec.ts` (extended) | Integration | All three migrations apply and revert cleanly, creating and dropping the `videos` table |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with its `forFeature` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the enum type, the unique index on `public_id` and the FK to `channels`
- Inserting two videos with the same `public_id` fails with a unique violation
- A video row inserted without a status defaults to `draft`
- Migration revert drops the table and the enum type, leaving the database re-migratable

---

### SI-03.4 — Storage Module: S3 Gateway

**Description:** Wrap the S3 client in a storage service that owns every object-storage operation the phase needs — multipart lifecycle, presigned URL generation, object upload and deletion — so no other module talks to the SDK directly.

**Technical actions:**

- Create `src/storage/storage.service.ts` exposing: `createMultipartUpload(key, contentType)`, `getPartUploadUrls(key, uploadId, partCount)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `getPresignedDownloadUrl(bucket, key, options?)`, `putObject(bucket, key, body, contentType)`, `deleteObject(bucket, key)`, and `getObjectStream(bucket, key)` for the worker to fetch the source
- Construct the `S3Client` with `forcePathStyle: true` (required for MinIO) and the configured endpoint/credentials, injected via `ConfigType<typeof storageConfig>`
- Sign URLs against `STORAGE_PUBLIC_ENDPOINT` so the URL handed to a browser resolves from outside the Compose network, while server-side operations use the internal `STORAGE_ENDPOINT`
- Create `src/storage/storage.module.ts` exporting `StorageService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: full multipart round-trip (create → upload two parts via the presigned URLs → complete → object readable with the expected bytes); abort removes the pending upload; presigned GET returns the object; presigned GET with a `Range` header returns **206** with a correct `Content-Range`; `deleteObject` removes it |
| `src/storage/storage.service.spec.ts` | Unit | Key/bucket selection and presign option assembly, with the S3 client mocked |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A multipart upload of a multi-part payload completes and the reassembled object matches the input byte-for-byte
- A presigned GET issued by the service answers `206 Partial Content` for a ranged request — the mechanism TD-10 relies on
- Aborting a multipart upload leaves no object behind
- No module outside `StorageModule` imports from `@aws-sdk/*`

---

### SI-03.5 — Queue Module: Producer and Job Contract

**Description:** Register the BullMQ connection and the video-processing queue, and define the job name and payload contract shared by producer and consumer.

**Technical actions:**

- Create `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'` and `PROCESS_VIDEO_JOB = 'process-video'`
- Create `src/queue/video-processing-job.types.ts` — `interface ProcessVideoJobData { videoId: string }` (thin payload, per TD-13)
- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` reading `queueConfig` for the Redis connection, plus `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; export `BullModule`
- Create `src/queue/video-processing.producer.ts` — injects the queue via `@InjectQueue` and exposes `enqueueVideoProcessing(videoId)`, adding the job with `jobId: videoId` (so a duplicate enqueue for the same video collapses), `attempts` from `videoConfig`, exponential backoff, `removeOnComplete: true` and `removeOnFail: false` — per TD-12, TD-13

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-processing.producer.integration-spec.ts` | Integration | Against real Redis: enqueuing adds a job whose data is `{ videoId }` and whose options carry the configured attempts and backoff; enqueuing the same video twice yields exactly one job |
| `src/queue/video-processing.producer.spec.ts` | Unit | Job name, `jobId` and options assembled from config, with the queue mocked |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A job enqueued by the producer is visible in Redis with the expected name and payload
- Enqueuing twice for one video id produces a single job (deduplication by `jobId`)
- The queue connects using the Compose service name `redis`

---

### SI-03.6 — Upload Initiation: Draft Pre-registration and Presigned Part URLs

**Description:** Expose the endpoint that pre-registers the video as a draft and returns everything the client needs to upload directly to storage. This is the capability "pré-cadastro automático do vídeo como rascunho ao iniciar o upload".

**Technical actions:**

- Create `src/videos/dto/initiate-upload.dto.ts` — `filename` (string, required, max 255), `contentType` (string, required, must be in the configured allowlist), `sizeBytes` (int, required, positive, at most `VIDEO_MAX_SIZE_BYTES`), `title` (string, optional, max 255, defaulting to the filename stem)
- Create `src/videos/public-id.util.ts` — `generatePublicId()` returning `crypto.randomBytes(8).toString('base64url')` (11 URL-safe characters), per TD-09
- Create `src/videos/videos.service.ts` with `initiateUpload(userId, dto)`: resolve the channel via `ChannelsService.findByUserId` (per TD-17), reject with `ChannelNotFoundException` when absent; validate `contentType` against the allowlist and `sizeBytes` against the ceiling (per TD-15); generate a unique `public_id`, retrying on unique violation; persist the `Video` row as `draft` with its storage key `{videoId}/source{ext}`; call `StorageService.createMultipartUpload`; compute the part count from `sizeBytes` and the configured part size; return the video, the upload id and the presigned part URLs
- Create `src/videos/videos.controller.ts` with `POST /videos/uploads` (authenticated; the global guard already applies, so no `@Public()`), reading the user via `@CurrentUser()`
- Add domain exceptions to `src/videos/exceptions/`: `ChannelNotFoundException` (404), `UnsupportedVideoFormatException` (415), `VideoTooLargeException` (413) — all extending the inherited `DomainException`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Returns 11 URL-safe characters; 10,000 generations are unique; alphabet is `[A-Za-z0-9_-]` only |
| `src/videos/videos.service.spec.ts` | Unit | Allowlist and size-ceiling rejection; part-count arithmetic including the non-round remainder case; public-id retry on unique violation |
| `src/videos/videos.service.integration-spec.ts` | Integration | Draft row persisted with `status = draft` and the owning channel; real multipart upload created in MinIO |
| `test/videos.e2e-spec.ts` | E2E | 201 with upload id, part URLs and the video's `publicId`; 401 unauthenticated; 415 on a disallowed content type; 413 above the size ceiling; 400 on a malformed body |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Initiating an upload creates a video row with `status = draft` bound to the caller's channel
- The response carries one presigned URL per part, and the count matches `ceil(sizeBytes / partSize)`
- A 10GB declared size yields ~100 part URLs at the default part size and is accepted; anything above the ceiling is rejected with 413 before any storage call
- An unauthenticated request is rejected with 401 by the inherited global guard

---

### SI-03.7 — Upload Completion and Abort

**Description:** Finalise the multipart object, move the video into `processing`, and enqueue the job — the moment the pipeline becomes asynchronous. Also expose the abort path that reclaims an abandoned upload.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `uploadId` (string, required) and `parts` (array, required, non-empty, each `{ partNumber: int >= 1, etag: string }`), validated with `@ValidateNested`
- Add `completeUpload(userId, videoId, dto)` to `VideosService`: load the video, reject when the caller does not own its channel (`VideoNotFoundException`, 404 — an ownership failure is reported as not-found so a video's existence is not disclosed), reject when the status is not `draft` (`InvalidVideoStateException`, 409); sort parts ascending by `partNumber`; call `StorageService.completeMultipartUpload`; transition the row to `processing`; enqueue via `VideoProcessingProducer`
- Add `abortUpload(userId, videoId)`: same ownership and state checks, `AbortMultipartUpload` against storage, then delete the draft row (per TD-04)
- Add `POST /videos/:id/uploads/complete` and `DELETE /videos/:id/uploads` to the controller
- The storage completion happens before the status transition, so a failure to assemble the object leaves the row in `draft` and retryable rather than stranding it in `processing`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` (extended) | Unit | Ownership rejection; state rejection when not `draft`; parts sorted before the storage call; enqueue invoked once on success |
| `src/videos/videos.service.integration-spec.ts` (extended) | Integration | Against real MinIO and Redis: completing a genuine two-part upload assembles the object, flips the row to `processing` and enqueues exactly one job; abort removes both the pending upload and the draft row |
| `test/videos.e2e-spec.ts` (extended) | E2E | Full HTTP flow initiate → PUT parts to the presigned URLs → complete returns 200 with `status: processing`; 409 completing twice; 404 completing another channel's video; abort returns 204 |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- Completing an upload assembles the object in storage and leaves the row in `processing`
- Exactly one job is enqueued per completed upload
- Completing an already-completed upload returns 409
- Completing or aborting another user's video returns 404, disclosing nothing
- Aborting leaves neither a pending multipart upload nor a draft row

---

### SI-03.8 — FFmpeg Service: Metadata Extraction and Thumbnail Generation

**Description:** Wrap the two FFmpeg invocations the phase needs behind a small, unit-testable service, invoked without a shell and under an explicit timeout.

**Technical actions:**

- Create `src/videos/processing/ffmpeg.service.ts` with `probe(filePath)` and `extractThumbnail(filePath, outputPath, atSeconds)`
- `probe` runs `ffprobe -v error -print_format json -show_format -show_streams <file>` via `child_process.execFile` with the path from `@ffprobe-installer/ffprobe`, parses the JSON, selects the first stream with `codec_type === 'video'`, and returns `{ durationSeconds, width, height, videoCodec, audioCodec, bitrate, sizeBytes, raw }` — numeric fields arrive as strings and are parsed explicitly (per TD-14)
- `extractThumbnail` runs `ffmpeg -y -ss <seconds> -i <file> -frames:v 1 -vf scale=1280:-2 -q:v 2 <out>` with the path from `@ffmpeg-installer/ffmpeg`. `-ss` precedes `-i` for an input-side seek, and `scale=1280:-2` keeps the derived height even as the JPEG encoder requires (per TD-08)
- Both calls pass arguments as an **array** so no shell interprets the filename, and both set `timeout: VIDEO_FFMPEG_TIMEOUT_MS` plus a `maxBuffer` bound (per TD-07)
- `probe` throws `VideoProbeFailedException` when FFmpeg exits non-zero or no video stream is present — this is the content authority decided in TD-15
- Add `computeThumbnailTimestamp(durationSeconds)` returning `max(1, duration * 0.10)`, clamped below the duration for very short inputs (per TD-08)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/ffmpeg.service.spec.ts` | Unit | Against a small fixture generated by FFmpeg itself at test setup: `probe` returns the expected duration, dimensions and codecs; `extractThumbnail` writes a non-empty JPEG whose magic bytes are correct; a non-video file makes `probe` throw `VideoProbeFailedException`; `computeThumbnailTimestamp` honours the floor and the short-video clamp |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `probe` returns a duration matching the fixture within a small tolerance, plus width, height and codec names
- `extractThumbnail` produces a readable JPEG at the requested timestamp
- A text file passed to `probe` raises `VideoProbeFailedException` rather than hanging or returning garbage
- Neither call is routed through a shell

---

### SI-03.9 — Video Processing Consumer

**Description:** The job handler that turns an uploaded object into a `ready` video: download, probe, thumbnail, upload, persist, transition. Idempotent, because delivery is at-least-once.

**Technical actions:**

- Create `src/videos/processing/video-processing.consumer.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })` extending `WorkerHost`, implementing `process(job: Job<ProcessVideoJobData>)`
- Handler flow: load the video by id (missing row → return, the job is obsolete); if already `ready`, return without work (idempotency, per TD-13); stream the source object from storage into a temporary file; `probe` it; compute the thumbnail timestamp and extract the frame; upload the JPEG to the thumbnails bucket at `{videoId}.jpg`; persist duration, dimensions, codecs, size, the raw `ffprobe` document and the thumbnail key; transition to `ready`
- Always clean up the temporary directory in a `finally` block, so a failure cannot leak multi-GB scratch files
- Let failures propagate so BullMQ applies the configured retry and backoff. Add an `@OnWorkerEvent('failed')` handler that, once `job.attemptsMade` has reached the configured maximum, writes `status = failed` and stores the reason in `processing_error` (per TD-12)
- Create `src/videos/processing/processing.module.ts` wiring the consumer, `FfmpegService`, `StorageModule` and the `Video` repository

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.consumer.spec.ts` | Unit | Skips work when the video is already `ready`; returns quietly when the row is gone; temporary directory removed on both success and failure |
| `src/videos/processing/video-processing.consumer.integration-spec.ts` | Integration | Against real MinIO: a genuine uploaded video is probed, its thumbnail written to the thumbnails bucket, metadata persisted and status moved to `ready`; a corrupt object drives the row to `failed` with a stored reason after the configured attempts; re-running the handler on a `ready` video changes nothing |

**Dependencies:** SI-03.4, SI-03.5, SI-03.8

**Acceptance criteria:**

- A completed upload becomes `ready` with duration, width, height, codecs and a thumbnail key populated
- The thumbnail object exists in the thumbnails bucket and is a valid JPEG
- A corrupt or non-video file ends as `failed` with a human-readable `processing_error`
- Processing the same video twice leaves it `ready` and does not duplicate the thumbnail
- No temporary files remain after either outcome

---

### SI-03.10 — Worker Bootstrap and Compose Service

**Description:** Boot the consumer as its own process so FFmpeg cannot block the API event loop, per TD-05.

**Technical actions:**

- Create `src/worker/worker.module.ts` importing `ConfigModule` (global), `TypeOrmModule.forRootAsync` (the same factory the API uses), `QueueModule` and `ProcessingModule` — deliberately not `AppModule`, so the worker never registers HTTP controllers or the global guard
- Create `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule)` with `app.enableShutdownHooks()`, so SIGTERM lets an in-flight job finish before the process exits
- Add npm scripts `start:worker:dev` (`nest start --watch --entryFile worker/main`) and `start:worker:prod` (`node dist/worker/main`)
- Wire the `video-worker` Compose service added in SI-03.1 to `start:worker:dev`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/worker.module.spec.ts` | Unit | The worker module compiles and resolves the consumer, without instantiating HTTP controllers |

**Dependencies:** SI-03.1, SI-03.9

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` and it stays running
- A video completed through the API reaches `ready` with no manual step, processed by the worker container
- `docker compose logs video-worker` shows job pickup and completion
- The worker exposes no HTTP port

---

### SI-03.11 — Video Retrieval by Public URL

**Description:** Expose the video by its short unique identifier — the read contract Fase 04 and Fase 05 consume.

**Technical actions:**

- Add `findByPublicId(publicId)` to `VideosService`, returning the video with its channel; throw `VideoNotFoundException` when absent
- Add `GET /videos/:publicId` to the controller, marked `@Public()` (per TD-16)
- Return a response DTO exposing `publicId`, `title`, `status`, `durationSeconds`, `width`, `height`, `thumbnailUrl`, `channel { id, nickname, name }` and `createdAt` — never the internal id, the storage keys or the raw metadata blob
- Build `thumbnailUrl` as a plain public URL against the thumbnails bucket, which needs no signing (per TD-02)
- Videos not yet `ready` resolve for their owner but answer 404 for everyone else, so an unfinished upload is not publicly discoverable

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` (extended) | Unit | `findByPublicId` throws `VideoNotFoundException` for an unknown id |
| `test/videos.e2e-spec.ts` (extended) | E2E | 200 anonymously for a `ready` video with the expected shape; internal id and storage keys absent from the body; 404 for an unknown public id; 404 anonymously for a video still `processing` |

**Dependencies:** SI-03.3, SI-03.6

**Acceptance criteria:**

- A `ready` video is retrievable by its 11-character public id without authentication
- A video that is not `ready` is returned to the channel that owns it (so the owner can poll upload progress) and 404s for everyone else
- The payload never leaks the internal id, storage keys or the raw `ffprobe` document
- Two videos never share a public id (unique index enforced at the database level)

---

### SI-03.12 — Streaming and Download Endpoints

**Description:** Deliver playback and download by redirecting to short-lived presigned URLs, so the storage engine serves ranges and the API never carries video bytes.

**Technical actions:**

- Add `getStreamUrl(publicId)` to `VideosService`: resolve the video, reject anything not `ready` with `VideoNotReadyException` (404), and return a presigned GET valid for the configured expiry (per TD-10)
- Add `getDownloadUrl(publicId)`: same resolution, but sign with `ResponseContentDisposition: attachment; filename="<sanitised>.<ext>"` and `ResponseContentType: application/octet-stream` (per TD-11). Sanitise the filename to strip quotes, control characters and path separators before it enters the signed header
- Add `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` to the controller, both `@Public()` (per TD-16), both answering `302` with the presigned URL in `Location`
- Document in the controller that ranged requests are served by storage, not by the API — the redirect target answers `206`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` (extended) | Unit | Non-`ready` statuses raise `VideoNotReadyException`; the download signature carries a sanitised `ResponseContentDisposition` |
| `test/videos.e2e-spec.ts` (extended) | E2E | Streaming returns 302; **following the Location with a `Range: bytes=0-1023` header returns 206 with a `Content-Range` and exactly 1024 bytes** — proving playback without a full download; download returns 302 to a URL whose response carries `Content-Disposition: attachment`; both return 404 for a `processing` video |

**Dependencies:** SI-03.4, SI-03.9, SI-03.11

**Acceptance criteria:**

- A ranged request against the streaming redirect target returns `206 Partial Content` with a correct `Content-Range` and only the requested bytes
- The download target responds with `Content-Disposition: attachment` and the expected filename
- Neither endpoint transfers video bytes through the API process
- Both refuse a video that is not `ready`

---

### SI-03.13 — Authorization, Error Catalog, and OpenAPI Documentation

**Description:** Close the HTTP surface — Swagger decorators, the exported OpenAPI document, and confirmation that the authorization matrix holds end to end.

**Technical actions:**

- Annotate every video endpoint with `@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse` and `@ApiBearerAuth` where authentication applies, matching the Fase 02 conventions
- Add response DTO classes with `@ApiProperty` so the generated schema is accurate rather than `object`
- Register the new domain exceptions with the inherited `DomainExceptionFilter` — they extend `DomainException`, so the existing filter renders them without change
- Regenerate `openapi.json` via `npm run openapi:export`
- Verify the throttler inherited from Fase 02 applies to the upload endpoints

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/swagger.e2e-spec.ts` (extended) | E2E | The OpenAPI document lists every video path with its documented responses |
| `test/videos.e2e-spec.ts` (extended) | E2E | The authorization matrix in § Authorization Matrix holds for every endpoint and caller class |

**Dependencies:** SI-03.6, SI-03.7, SI-03.11, SI-03.12

**Acceptance criteria:**

- Every video endpoint appears in `openapi.json` with accurate request and response schemas
- Every domain error renders as `{ statusCode, error, message }` per the inherited contract
- The authorization matrix is exercised by tests, not merely documented

---

### SI-03.14 — Inherited Lint Debt Cleanup

**Description:** `npm run lint` fails on the inherited Phase 01/02 code with 150 errors, so the project's own Definition of Done cannot pass. This is pre-existing debt, isolated in its own SI so it never mixes with Phase 03 scope.

**Technical actions:**

- Fix the errors in production code properly: `src/channels/channels.service.ts` (6) and `src/test/create-test-data-source.ts` (1), by typing the values rather than suppressing the rule
- Add a scoped ESLint override in `eslint.config.mjs` for test files (`**/*.spec.ts`, `**/*.integration-spec.ts`, `test/**/*.ts`) downgrading the `no-unsafe-*` family and `unbound-method` to `warn`, consistent with how the project already treats `no-unsafe-argument` and `no-explicit-any`. Test files legitimately handle untyped fixtures, `supertest` response bodies and Jest mocks
- Keep all Phase 03 code free of even the downgraded warnings

**Tests:** No new tests — verified by `npm run lint` exiting 0.

**Dependencies:** None

**Acceptance criteria:**

- `npm run lint` exits 0
- No `eslint-disable` comment is added to production code
- Phase 03 sources produce no lint warnings

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(16) | unique, not null — 11-char base64url (TD-09) |
| channel_id | uuid | FK → channels.id, not null |
| title | varchar(255) | not null |
| status | enum(`draft`,`processing`,`ready`,`failed`) | not null, default `draft` (TD-12) |
| storage_key | varchar(512) | not null — `{videoId}/source{ext}` in the videos bucket |
| upload_id | varchar(255) | nullable — S3 multipart upload id, cleared on completion |
| thumbnail_key | varchar(512) | nullable — `{videoId}.jpg` in the thumbnails bucket |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — validated against the allowlist (TD-15) |
| size_bytes | bigint | nullable — declared at initiate, corrected from probe |
| duration_seconds | numeric(12,3) | nullable — populated by processing |
| width | int | nullable |
| height | int | nullable |
| video_codec | varchar(50) | nullable |
| audio_codec | varchar(50) | nullable |
| bitrate | int | nullable |
| metadata | jsonb | nullable — raw `ffprobe` document (TD-14) |
| processing_error | text | nullable — reason when status is `failed` (TD-12) |
| created_at | timestamp | CreateDateColumn |
| updated_at | timestamp | UpdateDateColumn |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel` via `channel_id`
**Indexes:** unique on `public_id`; index on `(channel_id, status)` for the Fase 04 management listing

### API Contracts

#### POST /videos/uploads (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access token&gt;

**Request body:**
- filename: string, required — max 255 characters
- contentType: string, required — must be in the configured MIME allowlist
- sizeBytes: integer, required — positive, at most `VIDEO_MAX_SIZE_BYTES` (default 10GB)
- title: string, optional — max 255; defaults to the filename stem

**Response 201:**
- videoId: string (uuid)
- publicId: string — 11-character base64url
- status: string — always `draft`
- uploadId: string — S3 multipart upload id
- partSizeBytes: integer
- parts: array of `{ partNumber: integer, url: string }` — one presigned PUT URL per part
- expiresIn: integer — seconds until the part URLs expire

**Error responses:**
- 401 unauthorized: when no valid access token is supplied
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel
- 413 VIDEO_TOO_LARGE: when `sizeBytes` exceeds the configured maximum
- 415 UNSUPPORTED_VIDEO_FORMAT: when `contentType` is not in the allowlist
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/uploads/complete (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access token&gt;

**Request body:**
- uploadId: string, required
- parts: array, required, non-empty — each `{ partNumber: integer ≥ 1, etag: string }`

**Response 200:**
- videoId: string (uuid)
- publicId: string
- status: string — always `processing`

**Error responses:**
- 401 unauthorized: when no valid access token is supplied
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller's channel
- 409 INVALID_VIDEO_STATE: when the video is not in `draft`
- 400 validation error: when the body fails schema validation or the part list is empty

---

#### DELETE /videos/:id/uploads (SI-03.7)

**Request headers:**
- Authorization: Bearer &lt;access token&gt;

**Response 204:** No content.

**Error responses:**
- 401 unauthorized: when no valid access token is supplied
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the caller's channel
- 409 INVALID_VIDEO_STATE: when the video is not in `draft`

---

#### GET /videos/:publicId (SI-03.11)

**Response 200:**
- publicId: string
- title: string
- status: string
- durationSeconds: number | null
- width: integer | null
- height: integer | null
- thumbnailUrl: string | null — public URL, unsigned
- channel: `{ id: string, nickname: string, name: string }`
- createdAt: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has that public id, or it is not `ready` and the caller is not its owner

---

#### GET /videos/:publicId/stream (SI-03.12)

**Response 302:** `Location` carries a short-lived presigned GET URL. The client follows it and issues `Range` requests directly to object storage, which answers `206 Partial Content` with `Content-Range` and `Accept-Ranges: bytes`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has that public id
- 404 VIDEO_NOT_READY: when the video has not finished processing

---

#### GET /videos/:publicId/download (SI-03.12)

**Response 302:** `Location` carries a presigned GET URL signed with `response-content-disposition=attachment; filename="<name>"` and `response-content-type=application/octet-stream`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video has that public id
- 404 VIDEO_NOT_READY: when the video has not finished processing

---

#### Validation Rules — Upload

- `filename`: required, string, max 255 characters
- `contentType`: required, must be one of `VIDEO_ALLOWED_MIME_TYPES` (default `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`, `video/x-msvideo`)
- `sizeBytes`: required, integer, ≥ 1, ≤ `VIDEO_MAX_SIZE_BYTES` (default 10737418240)
- `title`: optional, string, max 255
- `uploadId`: required, non-empty string
- `parts`: required array, min 1 element; each element `partNumber` integer ≥ 1 and `etag` non-empty string

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos/uploads | ✗ | ✓ (creates in own channel) | ✓ |
| POST /videos/:id/uploads/complete | ✗ | ✗ (404) | ✓ |
| DELETE /videos/:id/uploads | ✗ | ✗ (404) | ✓ |
| GET /videos/:publicId (ready) | ✓ | ✓ | ✓ |
| GET /videos/:publicId (not ready) | ✗ (404) | ✗ (404) | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ |

Anonymous access to playback and download follows TD-16. Ownership failures are reported as 404 rather than 403 so that a video's existence is not disclosed to a non-owner.

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado não possui canal ao iniciar um upload |
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, ou operação de escrita sobre vídeo de outro canal |
| VIDEO_NOT_READY | 404 | Streaming ou download de vídeo que ainda não terminou o processamento |
| INVALID_VIDEO_STATE | 409 | Completar ou abortar upload de vídeo que não está em `draft` |
| VIDEO_TOO_LARGE | 413 | `sizeBytes` acima do limite configurado (padrão 10GB) |
| UNSUPPORTED_VIDEO_FORMAT | 415 | `contentType` fora da allowlist configurada |
| VIDEO_PROBE_FAILED | 422 | `ffprobe` não reconhece o arquivo como vídeo decodificável (erro registrado em `processing_error`) |

### Events/Messages

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` (per `phase-03-videos/TD-13`) — invoked by `VideosService.completeUpload` immediately after the multipart object is assembled.
**Consumer:** `VideoProcessingConsumer` running in the `video-worker` container (per `phase-03-videos/TD-05`).
**Trigger:** the client confirms that every part has been uploaded and the API successfully finalises the multipart upload (per `phase-03-videos/TD-04`).
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-13`). The handler is idempotent — it reloads current state and returns without work when the video is already `ready` — so redelivery is safe. The job is added with `jobId` set to the video id, so a duplicate enqueue for the same video collapses into one job.
**Queue:** `video-processing` on Redis (per `phase-03-videos/TD-01`).
**Retry policy:** 3 attempts with exponential backoff starting at 5s (per `phase-03-videos/TD-12`). After the final attempt the consumer's `failed` listener writes `status = failed` and stores the reason in `processing_error`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.3
├── SI-03.4
├── SI-03.5
└── SI-03.8

SI-03.2 (no deps)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.6
    └── SI-03.7   (also needs SI-03.5)

SI-03.4 + SI-03.5 + SI-03.8
└── SI-03.9
    └── SI-03.10  (also needs SI-03.1)

SI-03.3 + SI-03.6
└── SI-03.11
    └── SI-03.12  (also needs SI-03.4, SI-03.9)

SI-03.6 + SI-03.7 + SI-03.11 + SI-03.12
└── SI-03.13

SI-03.14 (no deps — inherited debt, independent of the phase chain)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.5, SI-03.8 (parallel after SI-03.1) → SI-03.6 → SI-03.7 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13. SI-03.14 is independent and may be applied at any point; it is scheduled last so the inherited lint baseline stays measurable while Phase 03 code is written.

## Deliverables

- [x] MinIO object storage running in Docker Compose with a private videos bucket and a public-read thumbnails bucket, created idempotently at startup
- [x] Redis and a BullMQ `video-processing` queue running in Docker Compose
- [x] A dedicated `video-worker` container consuming the queue, isolated from the API process
- [x] Upload of files up to 10GB via S3 multipart with presigned part URLs — video bytes never pass through the API
- [x] Automatic pre-registration of the video as `draft` when the upload is initiated
- [x] Automatic processing after upload: duration, dimensions, codecs, bitrate and the raw `ffprobe` document persisted
- [x] Automatic thumbnail generated from a frame at 10% of the video's duration and stored in the thumbnails bucket
- [x] Unique 11-character public URL per video, enforced by a database unique index
- [x] Streaming that begins without a full download — storage answers `206 Partial Content` for ranged requests
- [x] Download with a correct, tamper-proof `Content-Disposition` filename
- [x] Status lifecycle `draft` → `processing` → `ready` | `failed` persisted, with bounded retries and a stored failure reason
- [x] `videos` table created by a reviewed migration, linked to `channels`
- [x] `ChannelsService.findByUserId` closing the Fase 02 dependency gap
- [x] Video endpoints documented in `openapi.json`
- [x] Inherited lint debt cleared so `npm run lint` exits 0
- [x] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`docker compose exec nestjs-api npm run lint`)
