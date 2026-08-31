# phase-03-videos — Progress

**Status:** in progress
**SIs:** 3/14 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** 11/11 passing (env.validation.integration-spec.ts)
- **Observations:** Making `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` required broke the existing `requiredEnv` fixture in the inherited env test — added both there. MinIO's `minio-init` uses `mc anonymous set download` so the thumbnails bucket is publicly readable while the videos bucket is not; verified by anonymous GET returning 403 on videos and 404 on thumbnails (refused vs allowed-but-absent).

### SI-03.2 — Channel Lookup for Video Ownership
- **Status:** completed
- **Tests:** 36/36 passing (channels.service.spec, channels.service.integration-spec, users.service.integration-spec and the rest of the channels suite)
- **Observations:** `ChannelsService` gained an injected `Repository<Channel>` as a second constructor argument, so all three existing construction sites in tests needed updating (`new ChannelsService(dataSource)` → plus the repository).

### SI-03.3 — Video Entity, Status Enum, and Migration
- **Status:** completed
- **Tests:** 12/12 passing (video.entity.integration-spec: 8, videos.module.spec: 1, migrations.integration-spec: 3)
- **Observations:** `DROP TABLE ... CASCADE` does not drop PostgreSQL enum types — a leftover `videos_status_enum` makes the next `CREATE TYPE` fail. Added explicit enum drops to the migration suite and a test asserting the type is gone after revert. Also added `videos` to `cleanAllTables`. `bigint` and `numeric` map to `string` in TypeORM, so `size_bytes` and `duration_seconds` are typed as `string | null` rather than `number | null`.
