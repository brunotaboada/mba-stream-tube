---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-31T01:22:40+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-31T01:22:19+00:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Download capability did not state whether anonymous users may download"
    resolved_by: phase-03-videos/TD-16
  - id: MD-1
    status: resolved
    summary: "No TD decided accepted video formats or where size/type limits are enforced"
    resolved_by: phase-03-videos/TD-15
  - id: DG-1
    status: resolved
    summary: "ChannelsModule exposed no read path from authenticated user to channel"
    resolved_by: phase-03-videos/TD-17
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

Every TD in `## Decisions Index` carries a `Capability:` matching a bullet in `## Scope` verbatim. No two decided TDs imply mutually exclusive runtime behaviour — TD-02 (private videos bucket) and TD-10/TD-11 (presigned GET delivery) are complementary, since presigning is precisely how a private bucket is read. TD-16 (anonymous playback and download) is consistent with TD-02, because anonymity is granted at the API layer while the bucket itself stays private and is reached only through short-lived signed URLs. No TD carries `Scope: Frontend`, so the scope-subsection orphan check does not fire.

### Ambiguities

_None._

### Missing Decisions

_None._

Each of the nine capability bullets maps to at least one decided TD via `## Capability Coverage`. The error-response format for this phase's HTTP endpoints is inherited from `phase-02-auth/TD-07` rather than redefined, so the first-HTTP-phase rule is satisfied by inheritance.

### Dependency Gaps

_None._

The phase's prerequisites from Fase 02 — the global `JwtAuthGuard`, the `@CurrentUser()` decorator, `DomainException` plus its filter, and the `Channel` entity — are all present in `## Inherited Conventions` and verified to exist in `nestjs-project/src/`. The one genuine gap found (no user→channel read path) is closed by TD-17. Within-phase ordering is expressed in the plan's Dependency Map: storage and queue infrastructure precede the upload endpoints, which precede the worker, which precedes the delivery endpoints.

### Inherited Constraint Conflicts

_None._

TD-05 (separate worker container) is consistent with the inherited rule that Compose service names are the hosts for inter-service connections. TD-06 (npm-provisioned FFmpeg binaries) does not interact with the inherited `nest-cli.json` asset rule, since the binaries are resolved from `node_modules` at runtime rather than copied into `dist/`. TD-14 (raw `jsonb` column) ships in a reviewed migration, per the inherited migration-first rule. TD-17 was chosen specifically to preserve the inherited module-ownership convention that a service must not reach into another domain's entities.

### Unresolved Open Questions

_None._

All seventeen TDs in `docs/decisions/technical-decisions-phase-03-videos.md` carry a filled `**Decision:**` field.

### UI Coverage Gaps

_None._ — UI is out of scope for this phase (`next-frontend/` screens belong to Fase 04 and Fase 05), so no screen inventory exists and the check does not fire.

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-16)_ — The capability "Download do vídeo pelo usuário" did not say which users may download, while the project plan grants anonymous viewing. Resolved by deciding that streaming and download are both anonymous and gated on `ready` state, with mutating endpoints remaining authenticated and owner-scoped.
- **MD-1** _(resolved_by phase-03-videos/TD-15)_ — No decision covered accepted container formats, nor where size and type limits are enforced given that the API never sees the bytes. Resolved by gating the signing step with a configurable MIME allowlist and size ceiling, and making `ffprobe` the content authority during processing, reporting through the TD-12 status lifecycle.
- **DG-1** _(resolved_by phase-03-videos/TD-17)_ — Fase 02 shipped no read path from an authenticated user to their channel (`ChannelsService` exposed only `createChannel`, and the JWT payload is `{ sub, email }`). Resolved by adding `ChannelsService.findByUserId`, keeping channel reads inside the module that owns them rather than changing the auth contract.
