---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-31
scope_description: "Backend foundation for large-file video upload and asynchronous processing: object storage layout, presigned multipart upload, message queue, FFmpeg worker, metadata/thumbnail extraction, unique public URL, streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the video module, the object-storage gateway, the queue producer, the video-processing worker, and the streaming/download endpoints. Every TD in this document targets this subproject.
- `next-frontend/` — Frontend deferred: the video upload and playback screens belong to Fase 04 (Gerenciamento de Vídeos e Canal) and Fase 05 (Página de Visualização do Vídeo). No open decision in this document. The API contracts decided here (TD-03, TD-10, TD-11) are written to be consumed by that future frontend.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the C4 container diagram (`docs/diagrams/software-arch.mermaid`) both leave the queue explicitly as **TBD** — it is the one genuinely open stack choice of this phase. The queue carries video-processing jobs from the API to the worker. It must survive API restarts, retry failed jobs with backoff, and let a separate worker container consume at controlled concurrency. Video jobs are long-running (FFmpeg over multi-GB files), so visibility/lock renewal behaviour matters more than raw throughput.

**Options:**

### Option A: BullMQ + Redis (via `@nestjs/bullmq`)
- Redis-backed job queue with a first-party NestJS integration. `@nestjs/bullmq` supplies `BullModule.registerQueue()` for producers and a `@Processor()` decorator for consumers. Jobs are durable in Redis; retries, exponential backoff, delayed jobs, per-job progress, concurrency limits, and stalled-job recovery are built in.
- **Pros:** Smallest step from the current stack — one extra container (Redis) and one Nest module. Retry/backoff and dead-letter (the `failed` set) are configuration, not code. `job.updateProgress()` fits long FFmpeg runs. Stalled-job detection recovers work when a worker container dies mid-transcode. Excellent NestJS documentation and idiomatic DI. Queue state is trivially inspectable from tests via the same client.
- **Cons:** Adds Redis as a new piece of infrastructure with its own persistence story (AOF/RDB) — a job lost to an unflushed Redis write is a video stuck in `processing`. No routing/fanout semantics if the project later needs multiple independent consumers of the same event.

### Option B: RabbitMQ (via `@nestjs/microservices`)
- A dedicated AMQP broker. NestJS can bind a microservice transport to it, or `amqplib` can be used directly. Offers exchanges, routing keys, per-message acknowledgement, and true dead-letter exchanges.
- **Pros:** Purpose-built broker with the strongest delivery guarantees of the three. Explicit manual `ack`/`nack` maps cleanly onto "only acknowledge once the video is durably marked ready". Dead-letter exchanges are a first-class concept. Routing/fanout is available if later phases add more consumers.
- **Cons:** Materially more infrastructure and concepts (exchanges, queues, bindings, prefetch, DLX) than this phase needs — there is exactly one producer and one consumer. Long-running consumers require care with heartbeats: an FFmpeg run that outlives the heartbeat window drops the connection. Retry-with-backoff is not built in; it must be assembled from DLX plus TTL. Heaviest container of the candidates.

### Option C: pg-boss (PostgreSQL-backed queue)
- Runs the queue as tables inside the PostgreSQL instance the project already has, using `SKIP LOCKED` for concurrent job fetching. Supports retries, backoff, scheduling and archiving.
- **Pros:** Zero new infrastructure — no extra container, no extra healthcheck, no extra failure mode. Jobs and domain data share one transaction boundary, so "insert the video row and enqueue its job" can be genuinely atomic, eliminating the dual-write problem that A and B both have. One backup covers both.
- **Cons:** Couples background-processing load to the primary transactional database; long-running video jobs hold rows and connections in the same instance serving API traffic. No first-party NestJS integration, so the module wiring is hand-rolled. Weaker operational tooling and a much smaller community than BullMQ or RabbitMQ. Scaling the queue means scaling the database.

### Option D: AWS SQS
- Managed cloud queue; the worker long-polls for messages.
- **Pros:** No infrastructure to operate in production. Visibility timeouts fit long jobs. Native redrive policy to a dead-letter queue.
- **Cons:** Not runnable as real infrastructure in local Docker Compose — it would require ElasticMQ or LocalStack as a stand-in, meaning the thing exercised by tests is not the thing that runs in production. This phase's acceptance criteria demand a real queue in Compose. Also introduces cloud credentials and cost into a local-first project.

**Recommendation:** **BullMQ + Redis** — it is the only option that gives durable retries, backoff, concurrency control and stalled-job recovery as configuration rather than code, while adding a single lightweight container that runs identically in Compose and in production. RabbitMQ's extra guarantees buy nothing for a single-producer/single-consumer topology, and pg-boss's appealing atomicity is outweighed by putting multi-GB FFmpeg job churn on the primary database. The dual-write risk BullMQ carries is mitigated by TD-12's reconciliation rule (a video stuck in `processing` past a threshold is re-enqueued, not silently lost).

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: Object Storage Layout — Buckets and Key Structure

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage engine is **not** an open decision — `docs/project-plan.md` and the architecture diagram already fix S3-compatible object storage, realised locally as MinIO in Compose and swappable for S3 in production. What is open is how objects are organised: bucket count and key naming determine access-control granularity, lifecycle rules, and whether a thumbnail can be served without signing.

**Options:**

### Option A: Single bucket, prefix-separated (`videos/{id}/source.mp4`, `thumbnails/{id}.jpg`)
- One bucket holds everything; object type is encoded in the key prefix.
- **Pros:** One bucket to create and configure. Simplest bootstrap.
- **Cons:** Videos and thumbnails have genuinely different access policies — thumbnails are safe to expose publicly, source videos never are. A single bucket forces the stricter policy on both, so every thumbnail render needs a signed URL. Lifecycle and storage-class rules (video files are large and cold; thumbnails are small and hot) cannot be expressed per type.

### Option B: Two buckets — `streamtube-videos` (private) and `streamtube-thumbnails` (public-read)
- Source video objects live in a private bucket reachable only through signed URLs. Thumbnails live in a separate bucket with an anonymous read policy.
- **Pros:** Access policy matches the actual sensitivity of each object type. Thumbnails become plain cacheable URLs with no signing round-trip, which is exactly what the Fase 04 management panel and the Fase 07 home grid will render in bulk. Divergent lifecycle/storage-class rules become expressible. Compromise of a thumbnail URL leaks nothing.
- **Cons:** Two buckets to create and police in bootstrap. A public bucket must be scoped deliberately so nothing sensitive is ever written to it.

### Option C: Bucket per channel
- Each channel gets its own bucket.
- **Pros:** Hard tenant isolation; per-channel usage accounting is trivial.
- **Cons:** S3 caps buckets per account (100 by default, 1000 hard) — this cannot scale past a few hundred channels and would have to be undone later. Bucket creation on the user-registration path adds a failure mode to signup. Badly disproportionate to this project.

**Recommendation:** **Two buckets** — the access policies of source videos and thumbnails genuinely differ, and encoding that difference at the bucket boundary is what lets thumbnails be served as cheap public URLs while source media stays signed-only. Keys are `{videoId}/source{ext}` in the videos bucket and `{videoId}.jpg` in the thumbnails bucket, keeping the video's UUID as the single organising identifier. Bucket names come from configuration so production can point at real S3 buckets.

**Decision:** B (two buckets — private videos, public-read thumbnails)

---

## TD-03: Large-File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** This is the defining constraint of the phase, and `docs/project-plan.md` § Pontos de Atenção reinforces it: the upload must not stall the system and must be resumable after a connection failure. The decision determines whether bytes ever traverse the Node.js process.

**Options:**

### Option A: Proxy the file through the API (`multipart/form-data`)
- The client POSTs the file to a NestJS endpoint, which streams it onward to storage.
- **Pros:** One endpoint; the API sees the bytes and can validate content inline. No storage credentials or CORS on the client.
- **Cons:** Disqualifying. A 10GB body occupies a Node.js request handler for the entire transfer; a handful of concurrent uploads exhausts the event loop and connection pool, which is precisely the failure the phase exists to avoid. Any disconnect restarts the whole 10GB from zero. Node/Express body limits, proxy timeouts and load-balancer request caps all sit in the path. This is the explicit "reprova automática" case in the brief.

### Option B: Presigned single `PUT` direct to storage
- The API returns one presigned URL; the client PUTs the whole file straight to storage.
- **Pros:** Bytes bypass the API entirely. Trivial to implement — one signed URL.
- **Cons:** S3 caps a single `PUT` object at **5 GiB**, so a 10GB file is not expressible at all. Still not resumable: a failure at 9GB restarts from zero. Fails the stated requirement outright.

### Option C: S3 multipart upload with presigned part URLs
- The API calls `CreateMultipartUpload` and hands the client a presigned URL per part. The client uploads parts directly to storage — in parallel, retrying individual parts — then asks the API to finalise with `CompleteMultipartUpload`, passing the collected ETags.
- **Pros:** The only option that actually supports 10GB: parts may total 5 TiB, with 1–10,000 parts of 5 MiB–5 GiB each (the final part may be smaller). At a 100 MiB part size, a 10GB upload is ~100 parts, well inside the cap. Bytes never touch the API — it only signs URLs and finalises, so memory and event-loop cost are independent of file size. Resumability comes free: a failed part is retried alone, not the whole file. Parallel parts saturate available bandwidth. Native to both S3 and MinIO, so local and production behave identically.
- **Cons:** A three-call protocol (initiate → upload parts → complete) instead of one, so the client is more complex. Incomplete multipart uploads linger and consume storage until aborted. Requires CORS on the bucket for browser-origin uploads.

### Option D: tus resumable upload protocol
- An open protocol for resumable uploads, typically fronted by a `tus` server component.
- **Pros:** Purpose-built resumability with a well-specified protocol and mature clients. Handles pause/resume across sessions elegantly.
- **Cons:** Introduces a whole additional server component to run, route and secure — either inside the Nest process (reintroducing Option A's byte-proxying problem) or as yet another container. Its S3 backing store ultimately performs multipart uploads anyway, so it is a wrapper over Option C bought at the price of another moving part. Disproportionate when the S3 API already provides what is needed.

**Recommendation:** **S3 multipart upload with presigned part URLs** — it is the only candidate that satisfies the 10GB ceiling and the resumability requirement while keeping the API completely out of the data path, and it is native to the storage engine already fixed by the project plan. Part size is configurable with a default of 100 MiB (10GB → ~100 parts) and the API rejects declared sizes above the configured 10GB maximum before signing anything.

**Decision:** C (S3 multipart upload with presigned part URLs)

---

## TD-04: Upload Lifecycle Signals — Completion and Abort

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** TD-03 keeps the API out of the byte path, which means the API does not observe the last byte arriving. Something must tell it the object is complete so processing can be enqueued, and something must reclaim storage when an upload is abandoned.

**Options:**

### Option A: Explicit client-called completion endpoint
- The client, having uploaded every part, calls `POST /videos/:id/upload/complete` with the part ETags. The API issues `CompleteMultipartUpload`, flips the video to `processing`, and enqueues the job. A companion `DELETE /videos/:id/upload` issues `AbortMultipartUpload` and discards the draft.
- **Pros:** The API finalises the object itself, so it knows authoritatively that the object exists and is well-formed — `CompleteMultipartUpload` fails loudly on a missing or mismatched part. Status transition and job enqueue happen in one server-side request, which is directly testable end-to-end. No dependency on storage-vendor eventing, so MinIO and S3 behave identically. The abort path is explicit and immediate.
- **Cons:** Depends on the client making a final call; a client that uploads every part and then vanishes leaves the upload incomplete. Requires the reconciliation sweep noted in TD-12.

### Option B: Bucket event notification
- Storage emits an object-created event that the API or worker consumes.
- **Pros:** Fires from the storage layer itself, independent of client behaviour.
- **Cons:** Couples the design to vendor-specific notification wiring — MinIO's event targets are configured very differently from S3's, so the local stack would not exercise the production path. Adds a second asynchronous hop and its own delivery-failure mode. Events carry no application context, so the handler must reverse-map a key to a video row. Notably, the client must still be trusted to have uploaded every part, so this does not remove the abandonment problem it appears to solve.

### Option C: Server-side polling for object existence
- A scheduled task polls storage for expected keys.
- **Pros:** No client cooperation and no vendor eventing.
- **Cons:** Wasteful and latent by construction — processing starts up to one poll interval late. Cannot distinguish a complete multipart object from one still in flight without listing parts. Strictly worse than both alternatives.

**Recommendation:** **Explicit completion endpoint, plus an explicit abort endpoint** — it makes the API the authority on whether the object is complete, keeps behaviour identical across MinIO and S3, and puts the status transition and the enqueue in a single testable server-side action. Abandonment is handled by the reconciliation rule in TD-12 rather than by a more complex delivery mechanism.

**Decision:** A (explicit completion endpoint + explicit abort endpoint)

---

## TD-05: Video Processing Worker Runtime Topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram already names a **Video Worker (FFmpeg)** as a container distinct from the API. What is open is how that container is built and where its code lives.

**Options:**

### Option A: Worker inside the API process
- The API registers the BullMQ processor and consumes its own jobs.
- **Pros:** One container, one deployment, no new Dockerfile or Compose service.
- **Cons:** FFmpeg is CPU- and IO-heavy; running it beside the HTTP server means transcoding starves request handling — the exact coupling the phase is meant to break. API and worker can no longer be scaled independently (uploads and processing have very different load shapes). Contradicts the project's own architecture diagram.

### Option B: Separate Nest standalone application in the same codebase, own container
- A second entrypoint (`worker/main.ts`) boots a Nest application context — no HTTP listener — that imports only the modules the worker needs. It ships as its own Compose service from the same image and codebase.
- **Pros:** True process and resource isolation: FFmpeg cannot block the API event loop, and the worker scales independently. Entities, config, storage gateway and domain exceptions are shared as ordinary imports, so there is exactly one definition of the `Video` entity and no contract drift. One image and one dependency tree to build and keep in sync. Matches the architecture diagram. `NestFactory.createApplicationContext` is the framework's documented answer for non-HTTP workloads, and graceful shutdown hooks let in-flight jobs finish on SIGTERM.
- **Cons:** A second entrypoint, Compose service and set of environment wiring to maintain. Both processes are rebuilt when either changes.

### Option C: Separate repository/service
- The worker becomes its own project with its own dependencies.
- **Pros:** Maximum independence; could be written in another language.
- **Cons:** The `Video` entity, status enum and storage-key conventions would exist twice and drift. Needs its own CI, image and migration coordination. Unjustified for a monorepo course project explicitly built as one backend.

**Recommendation:** **Separate Nest standalone application in the same codebase** — it delivers the process isolation the architecture calls for while keeping a single source of truth for the entity, configuration and storage layout. The worker imports the shared modules directly, so the API↔worker contract cannot drift.

**Decision:** B (separate Nest standalone app, own container, shared codebase)

---

## TD-06: FFmpeg Provisioning in the Worker Image

**Scope:** Repo-wide

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker needs `ffprobe` (metadata) and `ffmpeg` (thumbnail frame). How those binaries get into the image is a cross-component concern: it binds the Dockerfile, the dependency manifest, and the code that resolves the binary path.

**Options:**

### Option A: `apt-get install ffmpeg` in the worker Dockerfile
- The image installs FFmpeg from the Debian repositories.
- **Pros:** Conventional and familiar. Binaries are distribution-maintained and security-patched. No extra `node_modules` weight.
- **Cons:** The exact FFmpeg version is whatever the distribution pins and it drifts between base-image rebuilds, so builds are not reproducible from the lockfile alone. Requires network access to Debian mirrors at build time — which fails outright in restricted or air-gapped build environments (and is in fact unreachable in this project's current build environment, where `deb.debian.org` is blocked). Diverges the worker image from the API image, meaning two Dockerfiles.

### Option B: Static binaries shipped as npm packages (`@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe`)
- Both packages ship prebuilt platform-specific binaries as optional dependencies resolved from the npm registry, and expose the resolved absolute path as `.path`.
- **Pros:** The binary version is pinned in `package-lock.json` alongside the application, so builds are reproducible and an upgrade is a reviewable dependency bump. Installation uses the npm registry the build already depends on — no second network dependency, and it works where distribution mirrors are unavailable. API and worker can share a single Dockerfile and image, since the difference collapses to the entrypoint command. The code resolves the path from the package rather than assuming a system location.
- **Cons:** Adds roughly 70–80 MB to `node_modules`. The bundled builds lag upstream FFmpeg — `@ffmpeg-installer/ffmpeg` currently ships a 2018-vintage static build — so newly added filters or codecs would not be available, and security fixes arrive only when the package is republished.

### Option C: Prebuilt FFmpeg base image (e.g. `jrottenberg/ffmpeg`)
- The worker image derives from an image that already contains FFmpeg.
- **Pros:** Current, well-optimised builds with no install step.
- **Cons:** The worker also needs Node.js, so the image must be assembled by copying between stages, adding build complexity. Ties the project to a third-party image's tagging and maintenance. Guarantees two divergent images for API and worker.

**Recommendation:** **Static binaries via npm** — pinning the FFmpeg version in the same lockfile as the application makes the build reproducible and lets API and worker share one image, and it removes a build-time dependency on distribution mirrors. The staleness of the bundled build is an accepted and bounded trade-off: this phase uses only `ffprobe`'s JSON metadata output and a single-frame `ffmpeg` extraction with `scale`, all long-stable functionality verified working against the pinned builds. Should a later phase need modern transcoding features, this TD should be revisited in favour of Option A or C.

**Decision:** B (`@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe`)

---

## TD-07: FFmpeg Invocation Binding

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Given the binaries from TD-06, the worker needs a way to invoke them and read their output.

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- A chainable JavaScript API over the FFmpeg CLI, with helpers such as `.screenshots()` and `ffprobe()`.
- **Pros:** Expressive, widely used, well-known idioms. Convenience helpers for thumbnails.
- **Cons:** The package has been effectively unmaintained for years and its typings are a separate `@types` package that drifts. It abstracts the CLI while still requiring CLI knowledge to debug. It hides process lifecycle, making timeouts and cancellation of a runaway FFmpeg harder to control precisely — which matters when the input is an untrusted multi-GB file.

### Option B: Direct `child_process.execFile` of `ffprobe`/`ffmpeg`
- A small internal service spawns the binaries with explicit argument arrays and parses `ffprobe`'s `-print_format json` output.
- **Pros:** No unmaintained dependency in the critical path. `execFile` with an argument array passes arguments to the kernel without a shell, so a hostile filename cannot inject a command. Timeout and buffer caps are first-class `execFile` options, giving direct control over runaway processes. `ffprobe -print_format json` is a stable, documented, machine-readable contract. The whole surface is two small, individually testable functions.
- **Cons:** Argument arrays must be assembled by hand, so FFmpeg CLI knowledge is required. No convenience helpers.

**Recommendation:** **Direct `execFile`** — the phase needs exactly two FFmpeg invocations, so a wrapper's convenience is negligible while its costs (an unmaintained dependency, weaker process control) are real. Passing arguments as an array avoids shell interpretation of attacker-influenced filenames, and explicit `timeout` bounds protect the worker from a malformed file that makes FFmpeg hang.

**Decision:** B (direct `child_process.execFile`)

---

## TD-08: Thumbnail Frame Selection and Encoding

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** "A frame of the video" needs a concrete, deterministic rule. Frame zero is frequently black or a fade-in, which would make most thumbnails useless.

**Options:**

### Option A: Fixed timestamp (e.g. always 1s)
- Seek to a constant offset.
- **Pros:** Trivial and perfectly deterministic.
- **Cons:** Ignores duration: 1s into a 3-hour film is still the opening titles, and for a 0.5s clip the seek lands past the end and yields nothing.

### Option B: Percentage of duration (10%), with a clamped floor
- `ffprobe` reports duration; the frame is taken at 10% of it, floored at 1s and additionally clamped for very short videos.
- **Pros:** Scales with content — 10% is past the intro for both a 30s clip and a 2h video. Duration is already known because the metadata extraction step (TD-14) runs first, so no extra probe. Deterministic and easy to assert in tests. Degrades safely on very short input via the clamp.
- **Cons:** Still arbitrary; no guarantee the frame is visually interesting.

### Option C: FFmpeg `thumbnail` filter (scene-based selection)
- FFmpeg's `thumbnail` filter picks the most representative frame from a window.
- **Pros:** Most likely to yield a visually meaningful frame.
- **Cons:** Must decode a window of frames rather than seeking directly, so it is markedly slower and heavier on large files. Non-deterministic from the test's point of view — assertions can only check that *a* JPEG appeared. Solves an aesthetic problem the phase does not pose.

**Recommendation:** **Percentage of duration with a floor** — it uses the duration already extracted, behaves sensibly across the full range of video lengths, and stays deterministic enough to assert precisely in tests. The frame is scaled to a 1280px width preserving aspect ratio (`scale=1280:-2`, keeping dimensions even for the JPEG encoder) and written as JPEG at quality 2, using an input-side `-ss` seek so the cost is independent of file size.

**Decision:** B (10% of duration, floored at 1s; JPEG, 1280px wide)

---

## TD-09: Unique Public Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `docs/project-plan.md` § Pontos de Atenção asks for a **short** URL that never collides. The primary key is a UUID, which is unique but long and enumerable-looking in a URL. The identifier is also a cross-component contract: it appears in the database, the API routes, and every future frontend link.

**Options:**

### Option A: Reuse the UUID primary key
- Routes are `/videos/{uuid}`.
- **Pros:** No new column, no new generation code, uniqueness guaranteed by the primary key.
- **Cons:** 36 characters — not short, and the project plan explicitly asks for a short URL. Exposes the internal primary key in public URLs, coupling external identifiers to internal storage.

### Option B: `nanoid`
- The standard short URL-safe ID generator; `nanoid(11)` gives ~66 bits of entropy.
- **Pros:** Purpose-built, widely adopted, well-audited alphabet.
- **Cons:** From v4 onward `nanoid` is **ESM-only** (the current v6 declares `"type": "module"`). This project compiles to CommonJS with `ts-jest`, so importing it requires either a dynamic `import()` in an otherwise synchronous path or pinning the abandoned v3 line. Both are friction for a function that is a few lines of standard-library code.

### Option C: `crypto.randomBytes` encoded as base64url
- `randomBytes(8).toString('base64url')` yields an 11-character URL-safe string carrying 64 bits of entropy, generated by the Node standard library.
- **Pros:** Same length and effectively the same entropy as `nanoid(11)`, with zero dependencies and no ESM/CommonJS problem. `base64url` is a built-in Node encoding producing only `[A-Za-z0-9_-]`, all URL-safe. Cryptographically strong, so identifiers are unguessable — which matters for the unlisted-video visibility arriving in Fase 04. Trivially unit-testable.
- **Cons:** Hand-rolled rather than a named library, so the rationale must be documented (this TD).

### Option D: `sqids`/`hashids` over the row's sequential id
- Encode an integer id into a short opaque string.
- **Pros:** Short, reversible, no storage column needed.
- **Cons:** Obfuscation, not randomness — ids remain enumerable by anyone who understands the scheme, which is unacceptable for unlisted videos. The project uses UUID primary keys, so there is no sequential integer to encode.

**Recommendation:** **`crypto.randomBytes(8).toString('base64url')`** — it matches `nanoid`'s length and entropy using only the standard library, sidestepping the ESM/CommonJS incompatibility that makes `nanoid` awkward here, and its cryptographic randomness makes identifiers unguessable ahead of the unlisted visibility feature. It is stored in a dedicated `public_id` column with a unique index; generation retries on the (vanishingly improbable) unique-violation so the guarantee is enforced by the database rather than by assumption.

**Decision:** C (`crypto.randomBytes(8).toString('base64url')`, unique-indexed `public_id` with retry)

---

## TD-10: Video Streaming Delivery

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Playback must begin without downloading the whole file, which means honouring HTTP `Range` requests and answering `206 Partial Content`. The C4 diagram is explicit that the frontend **streams from Object Storage**, not from the API — this TD decides how that is arranged while keeping the video's identity and status under API control.

**Options:**

### Option A: API proxies `Range` requests to storage
- `GET /videos/:publicId/stream` forwards the client's `Range` header to storage and pipes the partial body back with `206`, `Content-Range` and `Accept-Ranges`.
- **Pros:** Every request passes an authorisation check, so visibility rules can be enforced per byte range. The storage endpoint is never exposed and needs no CORS. Single-origin playback.
- **Cons:** Every byte of every view traverses the Node.js process. A handful of concurrent viewers consumes bandwidth and event-loop time proportional to watch time — reintroducing, on the read path, exactly the coupling TD-03 removed on the write path. Contradicts the architecture diagram.

### Option B: Redirect to a short-lived presigned `GET` URL
- `GET /videos/:publicId/stream` resolves the public id, checks the video is `ready`, and answers `302` with a short-lived presigned URL. The player then issues its `Range` requests straight to storage, which serves `206` natively.
- **Pros:** Range handling is done by the storage engine, which implements it correctly and efficiently; the API never carries video bytes, so its load is independent of viewer count and watch time. Matches the documented architecture. Short expiry bounds URL sharing, and authorisation is still enforced at redirect time. Identical behaviour on MinIO and S3, and a natural path to CDN fronting later.
- **Cons:** Once issued, the URL is valid until expiry regardless of later permission changes. Browser-origin playback needs CORS on the bucket. The client must follow redirects (universal in browsers and standard HTTP clients).

### Option C: Public bucket, unsigned URLs
- Video objects are world-readable and the URL is handed out directly.
- **Pros:** Simplest possible; ideal for CDN caching.
- **Cons:** No access control whatsoever and no expiry — anyone with the URL keeps it forever. Incompatible with the unlisted/private visibility arriving in Fase 04.

**Recommendation:** **Redirect to a short-lived presigned GET URL** — it delegates `Range`/`206` to the storage engine that implements it natively, keeps the API's cost independent of how much video is watched, and follows the architecture the project already documents, while still running an authorisation and status check on every request. Expiry is configurable and short.

**Decision:** B (302 redirect to short-lived presigned GET; storage serves Range/206)

---

## TD-11: Video Download Delivery

**Scope:** Backend

**Capability:** Download do vídeo pelo usuário

**Context:** Download differs from streaming only in intent: the browser should save the file under a sensible name instead of playing it inline.

**Options:**

### Option A: API streams the object with `Content-Disposition: attachment`
- The endpoint reads from storage and pipes the body, setting the download headers itself.
- **Pros:** Full control over headers and filename; the storage endpoint stays hidden.
- **Cons:** Pushes the entire multi-GB object through the API for every download — the same disqualifying cost as TD-10 Option A, and worse, because a download is always the whole file.

### Option B: Redirect to a presigned GET carrying response-header overrides
- The endpoint answers `302` with a presigned URL that includes `response-content-disposition=attachment; filename="..."` and `response-content-type`. Storage applies those headers to its response.
- **Pros:** Bytes bypass the API entirely, so download cost is independent of file size. S3's response-header override parameters are signed into the URL, so the filename cannot be tampered with. Consistent with TD-10, so both delivery paths share one signing helper. Resumable, because storage still honours `Range`.
- **Cons:** Same expiry and CORS considerations as TD-10.

**Recommendation:** **Presigned GET with response-header overrides** — it keeps whole-file transfers out of the API for the same reasons as TD-10 and reuses the same signing helper, while the signed `response-content-disposition` still guarantees a correct, tamper-proof download filename.

**Decision:** B (302 redirect to presigned GET with `response-content-disposition`)

---

## TD-12: Video Status Lifecycle and Processing-Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** The brief requires a status cycle of rascunho → processando → pronto/erro persisted in the database. The open questions are which states exist, and what happens when FFmpeg fails on a corrupt or unsupported file.

**Options:**

### Option A: Four states — `draft` → `processing` → `ready` | `failed`
- The row is created as `draft` when the upload is initiated, moves to `processing` when the upload is completed and the job enqueued, and ends `ready` or `failed`. Failures are retried a bounded number of times with exponential backoff before the row is marked `failed` with a persisted reason.
- **Pros:** Maps exactly onto the states the brief names, with no invented vocabulary. Each transition is caused by one identifiable event, so the state machine is small and fully testable. `failed` carries a reason column, so the future management panel can explain what went wrong and offer a retry.
- **Cons:** `draft` covers both "upload not started" and "upload in progress", so the two are not distinguishable from status alone.

### Option B: Add an explicit `uploading` state
- Distinguishes a draft whose upload has been initiated.
- **Pros:** Finer observability of abandoned uploads.
- **Cons:** Adds a state the brief does not ask for, and one that is not reliably observable anyway — the API is out of the byte path (TD-03) and so cannot tell "uploading" from "abandoned" without the same timeout heuristic that works directly on `draft`. Vocabulary beyond the requirement.

### Option C: Add a `queued` state between completion and worker pickup
- Separates "job enqueued" from "worker started".
- **Pros:** Distinguishes queue backlog from active work.
- **Cons:** The distinction belongs to the queue, which already tracks it and can be inspected there. Adds a state that changes twice in quick succession for no consumer benefit.

**Recommendation:** **Four states** — they match the brief exactly, each transition has exactly one cause, and richer distinctions are either unobservable given TD-03 or already owned by the queue. Retries are bounded (3 attempts, exponential backoff) so a genuinely corrupt file terminates in `failed` with a stored reason rather than looping forever. Because the enqueue in TD-04 is a dual write, a video left in `processing` beyond a configured threshold is treated as reconcilable and may be re-enqueued; the job is idempotent (TD-13) so re-running it is safe.

**Decision:** A (`draft` → `processing` → `ready` | `failed`, bounded retries, persisted failure reason)

---

## TD-13: Job Payload Contract and Delivery Semantics

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The job message is the contract between the API (producer) and the worker (consumer) — two separately deployed processes. Its shape determines how the system behaves when a job is delivered more than once, which BullMQ's at-least-once delivery makes a certainty rather than an edge case.

**Options:**

### Option A: Fat payload — all metadata in the message
- The message carries the video id, storage keys, channel id, title and so on.
- **Pros:** The worker needs no database read before starting.
- **Cons:** Message data is a snapshot taken at enqueue time and goes stale — a job retried later acts on values that may since have changed. Duplicates the entity's shape in a second place, so entity changes silently break older queued messages. Larger payloads in Redis.

### Option B: Thin payload — video id only
- The message carries `{ videoId }`; the worker loads the row and derives everything from it.
- **Pros:** One source of truth (the database), so a job can never act on stale data no matter how long it waited or how often it retried. The contract is one field, so it is stable across entity changes. Idempotency falls out naturally: the worker re-reads current state and can skip or safely redo work, which is what makes at-least-once delivery and the TD-12 reconciliation sweep safe. Minimal payload.
- **Cons:** One database read per job attempt — negligible next to an FFmpeg run.

### Option C: Hybrid — id plus a few denormalised fields
- Carries the id and a small set of convenience fields.
- **Pros:** Saves a read while keeping the id authoritative.
- **Cons:** Inherits Option A's staleness problem for whichever fields are copied, in exchange for savings that are irrelevant beside the cost of processing a video.

**Recommendation:** **Thin payload** — with at-least-once delivery, jobs must be safe to run more than once, and re-reading current state from the database is what makes that true. It also keeps the producer/consumer contract to a single field that cannot drift as the entity evolves. The job is keyed by the video id so a duplicate enqueue for the same video collapses rather than running twice.

**Decision:** B (thin payload `{ videoId }`, at-least-once delivery, idempotent handler)

---

## TD-14: Video Metadata Persistence Shape

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** `ffprobe` returns a large, deeply nested JSON document. The capability names duration explicitly and "metadata" generally; how much of that document is persisted, and in what shape, determines what later phases can query.

**Options:**

### Option A: Discrete typed columns only
- Duration, width, height, codecs, bitrate and size become individual columns; the rest is discarded.
- **Pros:** Every stored field is typed, indexable and directly queryable. Small rows and an obvious schema.
- **Cons:** Anything not anticipated now is lost for good, and recovering it means re-probing files. Each newly needed field costs a migration.

### Option B: Single `jsonb` blob
- The entire `ffprobe` output is stored as `jsonb`.
- **Pros:** Nothing is lost; new needs are served without a migration.
- **Cons:** Duration — needed on essentially every video listing — is buried behind JSON extraction, which is awkward to index and easy to get wrong. No type guarantees; every read must defensively parse. Stores a great deal of noise.

### Option C: Hybrid — discrete columns for the fields the product uses, plus raw `jsonb`
- Duration, width, height, codecs, bitrate and byte size are columns; the full `ffprobe` document is also kept in a `jsonb` column.
- **Pros:** The fields the product actually shows and sorts by are typed and indexable, while nothing is thrown away, so a later phase can add a field from already-stored data instead of re-probing every file. The `jsonb` column doubles as a diagnostic record of exactly what FFmpeg saw for a given file.
- **Cons:** The duration-shaped data exists in two places, so the extraction step must be the single writer of both. Somewhat larger rows.

**Recommendation:** **Hybrid** — duration and dimensions are needed on ordinary listing queries and deserve real columns, while retaining the raw document costs little and preserves information that would otherwise require re-probing multi-GB files to recover. The extraction step writes both in one operation, so the derived columns cannot drift from the raw record.

**Decision:** C (discrete columns for queried fields + raw `jsonb`)

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-02 | Object Storage Layout | Two buckets (private videos, public thumbnails) | B (two buckets) |
| TD-03 | Large-File Upload Strategy (10GB) | S3 multipart with presigned part URLs | C (multipart presigned) |
| TD-04 | Upload Lifecycle Signals | Explicit complete + abort endpoints | A (explicit endpoints) |
| TD-05 | Worker Runtime Topology | Separate Nest standalone app, own container | B (separate app, shared codebase) |
| TD-06 | FFmpeg Provisioning | Static binaries via npm | B (`@ffmpeg-installer` + `@ffprobe-installer`) |
| TD-07 | FFmpeg Invocation Binding | Direct `child_process.execFile` | B (direct `execFile`) |
| TD-08 | Thumbnail Frame Selection | 10% of duration, floored at 1s | B (percentage of duration) |
| TD-09 | Unique Public URL Identifier | `crypto.randomBytes` base64url | C (`randomBytes(8)` base64url) |
| TD-10 | Video Streaming Delivery | Redirect to presigned GET | B (302 to presigned GET) |
| TD-11 | Video Download Delivery | Presigned GET with disposition override | B (302 with `response-content-disposition`) |
| TD-12 | Status Lifecycle & Failure Handling | `draft`→`processing`→`ready`\|`failed` | A (four states, bounded retries) |
| TD-13 | Job Payload Contract | Thin payload, idempotent handler | B (thin `{ videoId }`) |
| TD-14 | Metadata Persistence Shape | Discrete columns + raw `jsonb` | C (hybrid) |
