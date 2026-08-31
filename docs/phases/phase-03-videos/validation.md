---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 3
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31T01:19:52+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T01:18:04+00:00"
issues:
  - id: AMB-1
    status: open
    summary: "Download capability does not state whether anonymous users may download"
  - id: MD-1
    status: open
    summary: "No TD decides accepted video formats or where size/type limits are enforced"
  - id: DG-1
    status: open
    summary: "ChannelsModule exposes no read path from authenticated user to channel"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

Every TD in `## Decisions Index` carries a `Capability:` that matches a bullet in `## Scope` verbatim. No two decided TDs imply mutually exclusive runtime behaviour — in particular TD-02 (private videos bucket) and TD-10/TD-11 (presigned GET delivery) are complementary, since presigning is precisely how a private bucket is read. No TD carries `Scope: Frontend`, so the scope-subsection orphan check does not fire.

### Ambiguities

- **AMB-1** — The capability "Download do vídeo pelo usuário" does not say which users. `docs/project-plan.md` § Principais Características states "qualquer pessoa pode assistir vídeos sem cadastro", which settles streaming but not download — "o usuário" could equally mean the authenticated owner downloading their own master file, or any viewer saving a video they can already watch. The two readings produce different authorization matrices for `GET /videos/:publicId/download`. Explicit choice: decide whether download is anonymous (same access as streaming) or owner-only, and record it in the Authorization Matrix.

### Missing Decisions

- **MD-1** — The capability "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" implies a limits-and-policies decision that no TD resolves: which container formats/MIME types are accepted, and at which point size and type are enforced. This is a genuine cross-component contract — the value appears in the request DTO validation, the Joi env schema, the storage key extension, and the worker's probe step — so it passes the (a) tie-breaker of the TD test and is not resolvable by best-practices alone. TD-03 mentions rejecting oversized declarations but does not decide the format policy or name the enforcement points. Explicit choice: run /plan-resolve to add a TD covering accepted formats and the enforcement points for size and type.

### Dependency Gaps

- **DG-1** — Every capability in this phase attaches a video to a channel, but Fase 02 shipped no read path from an authenticated user to their channel. Verified against the code: `src/channels/channels.service.ts` exposes only `createChannel(userId, email)`, and `src/auth/auth.types.ts` defines the JWT payload as `{ sub, email }` with no channel identifier. A video module cannot therefore resolve the owning channel without either querying the `Channel` repository directly — which the inherited convention forbids, since a module must not reach into another domain's entities — or changing the token payload, which would reopen Fase 02's auth contract. Explicit choice: decide where the user→channel lookup lives and record it as a prerequisite step of this phase.

### Inherited Constraint Conflicts

_None._

TD-05 (separate worker container) is consistent with the inherited rule that Compose service names are the hosts for inter-service connections. TD-06 (npm-provisioned FFmpeg binaries) does not interact with the inherited `nest-cli.json` asset rule, since the binaries are resolved from `node_modules` at runtime rather than copied into `dist/`. TD-14 (raw `jsonb` column) is consistent with the inherited migration-first rule, as the column ships in a reviewed migration.

### Unresolved Open Questions

_None._

All fourteen TDs in `docs/decisions/technical-decisions-phase-03-videos.md` carry a filled `**Decision:**` field; none are pending.

### UI Coverage Gaps

_None._ — UI is out of scope for this phase (`next-frontend/` screens belong to Fase 04 and Fase 05), so no screen inventory exists and the check does not fire.

## Resolved Issues

_No issues resolved yet._
