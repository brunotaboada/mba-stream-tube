---
libs:
  bullmq:
    version: "6.3.2"
    context7_id: null
    source: "npm registry + installed dist-types (see § Documentation sourcing)"
    fetched_at: "2026-08-31T01:40:00+00:00"
  "@nestjs/bullmq":
    version: "11.0.5"
    context7_id: null
    source: "npm registry + installed dist-types"
    fetched_at: "2026-08-31T01:40:00+00:00"
  "@aws-sdk/client-s3":
    version: "3.1121.0"
    context7_id: null
    source: "npm registry + installed dist-types"
    fetched_at: "2026-08-31T01:40:00+00:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1121.0"
    context7_id: null
    source: "npm registry + installed dist-types"
    fetched_at: "2026-08-31T01:40:00+00:00"
  "@ffmpeg-installer/ffmpeg":
    version: "1.1.0"
    context7_id: null
    source: "npm registry + binary probed in-container"
    fetched_at: "2026-08-31T01:40:00+00:00"
  "@ffprobe-installer/ffprobe":
    version: "2.1.2"
    context7_id: null
    source: "npm registry + binary probed in-container"
    fetched_at: "2026-08-31T01:40:00+00:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T01:32:00+00:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase. Re-fetch when the underlying TD changes.

## Documentation sourcing — deviation from `CLAUDE.md`

`CLAUDE.md` § Library Documentation Lookup mandates Context7 (MCP) for library documentation. **Context7 was not usable in the session that produced this document**, for two independent reasons:

1. The repository's `.mcp.json` did not declare a `context7` server at all. It has since been added (see the commit that introduced it), so the server is configured for future sessions.
2. Even with the server declared, `mcp.context7.com` is refused by this environment's egress policy, and the MCP server additionally requires an interactive OAuth authorization that a non-interactive session cannot complete.

Every API below was therefore verified against **two version-exact sources** rather than Context7:

- The **npm registry** (`registry.npmjs.org`), for published versions, module type (CommonJS vs ESM) and peer-dependency ranges.
- The **installed package's own `.d.ts` type definitions**, read inside the running container from `node_modules/`.

For the API-correctness purpose the rule exists to serve, reading the installed package's type declarations is *stronger* than prose documentation: it cannot drift from the version actually resolved in `package-lock.json`. Where behaviour is not expressible in types (FFmpeg CLI semantics, S3 multipart limits), the source is named inline.

**Version-compatibility findings that changed decisions:**

- `@nestjs/bullmq@12.0.0` declares `"type": "module"` — **ESM-only**. This project compiles to CommonJS (`ts-jest`, `sourceType: 'commonjs'`), so 12.x is unusable. The last CommonJS line is **11.0.5**, whose peer range is `@nestjs/common ^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6`. Pinned to `^11.0.5`.
- `nanoid@6` is likewise ESM-only, which is one of the reasons TD-09 chose `crypto.randomBytes` over `nanoid`.

---

## bullmq / @nestjs/bullmq

**Verified from:** `node_modules/@nestjs/bullmq/dist/**/*.d.ts` at 11.0.5, `bullmq` 6.3.2.

### Registering the connection and the queue (producer side)

`BullModule.forRootAsync` configures the shared Redis connection; `BullModule.registerQueue` declares a queue. Both are confirmed present as statics on `BullModule` in `dist/bull.module.d.ts`.

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },   // host is the Compose service name
  }),
}),
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
```

Injecting the producer uses `@InjectQueue(name)`:

```typescript
constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}

await this.queue.add(
  'process-video',
  { videoId },                                   // thin payload, per TD-13
  {
    jobId: videoId,                              // dedupes duplicate enqueues for the same video
    attempts: 3,                                 // bounded retries, per TD-12
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false,                         // keep failures inspectable
  },
);
```

`jobId` is BullMQ's deduplication key: adding a job whose id already exists in the queue is a no-op, which is what makes the TD-12 reconciliation sweep safe to run repeatedly.

### Consuming (worker side)

The consumer extends `WorkerHost` and is annotated with `@Processor`. Confirmed signatures:

```typescript
// dist/hosts/worker-host.class.d.ts
export declare abstract class WorkerHost<T extends Worker = Worker> {
  get worker(): T;
  abstract process(job: Job, token?: string): Promise<any>;
}

// dist/decorators/processor.decorator.d.ts — 4 overloads; the 2-arg form takes worker options
export declare function Processor(queueName: string, workerOptions: NestWorkerOptions): ClassDecorator;
```

```typescript
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ... */ }
}
```

`concurrency` is a **worker option** (second argument), not a processor option — the `ProcessorOptions` interface carries only `name`, `scope` and `configKey`.

Lifecycle events attach with `@OnWorkerEvent('failed' | 'completed' | ...)`, exported from `dist/decorators/on-worker-event.decorator`.

**Throwing from `process` marks the attempt failed**, which is what triggers BullMQ's retry/backoff. The handler must therefore let genuine failures propagate rather than swallow them; only after `attempts` are exhausted is the job final, which is where the row is marked `failed`.

---

## @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner

**Verified from:** `node_modules/@aws-sdk/client-s3/dist-types/**` and `.../s3-request-presigner/dist-types/getSignedUrl.d.ts` at 3.1121.0. Both packages are CommonJS.

### Client construction against MinIO

MinIO requires path-style addressing and a custom endpoint; region is required by the SDK but arbitrary for MinIO.

```typescript
new S3Client({
  endpoint: cfg.endpoint,          // http://minio:9000 — Compose service name
  region: cfg.region,
  forcePathStyle: true,            // required: MinIO does not do virtual-host buckets by default
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

### Multipart upload commands (TD-03)

All four commands are confirmed present in `dist-types/commands/`: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`.

```typescript
// 1. initiate — returns UploadId
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
  Bucket, Key, ContentType,
}));

// 2. one presigned URL per part (parts are 1-indexed)
const url = await getSignedUrl(s3, new UploadPartCommand({
  Bucket, Key, UploadId, PartNumber,
}), { expiresIn });

// 3. finalise with the ETags the client collected
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] },   // must be ascending by PartNumber
}));

// 4. abandon
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

**S3 multipart limits** (S3 API specification, implemented by MinIO): 1–10,000 parts; each part 5 MiB minimum except the last, 5 GiB maximum; 5 TiB maximum object. At the configured 100 MiB part size a 10GB upload is ~100 parts — two orders of magnitude inside the part cap. A single `PutObject` caps at 5 GiB, which is why multipart is not optional for this phase.

`CompleteMultipartUpload` fails if any part is missing or an ETag does not match, which is what makes the completion endpoint an authoritative check (TD-04).

### Presigned GET with response-header overrides (TD-10, TD-11)

`getSignedUrl` is confirmed as `(client, command, options?) => Promise<string>`. The `GetObjectCommand` input carries `ResponseContentDisposition` and `ResponseContentType` (confirmed at `models_0.d.ts` lines 9667 and 9682), which S3 applies to its response and which are covered by the signature — so a client cannot tamper with the download filename.

```typescript
// streaming — storage serves Range/206 itself
await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn });

// download — forces a save dialog with a controlled filename
await getSignedUrl(s3, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${safeName}"`,
  ResponseContentType: 'application/octet-stream',
}), { expiresIn });
```

`GetObjectCommand` also accepts `Range` (line 9657) and the response carries `ContentRange` (line 9427) — relevant only if the range-proxy alternative rejected in TD-10 were ever revisited.

---

## @ffmpeg-installer/ffmpeg and @ffprobe-installer/ffprobe

**Verified from:** npm registry metadata, plus executing both binaries inside the container.

Each package exports a resolved absolute path; the code must use that rather than assuming a system location:

```typescript
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
ffmpegInstaller.path;   // .../node_modules/@ffmpeg-installer/linux-x64/ffmpeg
ffprobeInstaller.path;  // .../node_modules/@ffprobe-installer/linux-x64/ffprobe
```

**Bundled build versions** (probed directly, and the reason TD-06 records a staleness trade-off): `@ffmpeg-installer/ffmpeg@1.1.0` ships a static build reporting `N-47683-g0e8eb07980` (2018); `@ffprobe-installer/ffprobe@2.1.2` ships `N-66595-gc2b38619c0` (2023). Both are ample for the two operations this phase performs.

### Metadata extraction (TD-14)

```
ffprobe -v error -print_format json -show_format -show_streams <file>
```

Emits a JSON document with a `format` object (`duration` as a **string** in seconds, `size`, `format_name`, `bit_rate`) and a `streams` array. Duration and dimensions must be read from the video stream (`codec_type === 'video'` → `width`, `height`, `codec_name`); numeric fields arrive as strings and require explicit parsing. Confirmed against a generated fixture in this environment.

### Thumbnail extraction (TD-08)

```
ffmpeg -y -ss <seconds> -i <file> -frames:v 1 -vf scale=1280:-2 -q:v 2 <out.jpg>
```

`-ss` **before** `-i` performs an input-side seek, so cost does not scale with file size. `scale=1280:-2` fixes width and derives an even height, which the JPEG encoder requires (`-1` can yield an odd height and fail). `-q:v 2` is high-quality JPEG. `-y` overwrites. Verified end-to-end in this environment against a generated 5-second test video.

Both binaries are invoked through `child_process.execFile` with an **argument array** (TD-07), so no shell parses the filename, and with an explicit `timeout` so a malformed input cannot hang the worker indefinitely.
