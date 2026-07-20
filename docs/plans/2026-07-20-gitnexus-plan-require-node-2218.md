# GitNexus Engineering Plan — Raise the gitnexus Node floor to 22.18+

> Task: Make `npm install` in `gitnexus/` warning-free by raising the supported Node floor to `^22.18.0 || >=24.11.0` (matching Babel 8, kept), removing the deprecated `@types/uuid` stub, and moving the CI lanes pinned below the new floor.
> Base commit: 2ea00a2b22c65073c77148d6f8303e0e31612851 (branch worktree-fix-ebadengine-babel8).
> Executed in overlay clone /home/node/gn-fix-ebadengine (the /workspace worktree is a 9p mount where the safe plan-writer's renameat2(RENAME_NOREPLACE) fails).

## 1. Objective

Eliminate the nine `npm warn EBADENGINE` warnings from the `@babel/*@8.x`
devDependencies and the `@types/uuid@11` deprecation warning, by adopting Node
22.18+ as the supported minimum rather than pinning Babel back to 7. This
supersedes the initial "pin Babel to 7" approach on maintainer direction:
the project will *support 22.18+* going forward.

## 2. Current behaviour

- `gitnexus/package.json` declares `engines: node >=22.0.0` but four
  devDependencies (`@babel/generator|parser|traverse|types`) are at `^8.0.0`
  (arrived via Dependabot #2518–#2520). Babel 8 declares
  `engines: node ^22.18.0 || >=24.11.0`, so every dev install on Node <22.18
  warns nine times (the direct four plus five transitive Babel packages).
- `@types/uuid@11.0.0` is a deprecated stub — `uuid@14` (a runtime dep) ships
  its own types, and no tsconfig `types` array references uuid.
- The only consumer of the Babel devDeps is the bench mutation oracle
  (`gitnexus/bench/impact-pdg/mutation-oracle.mjs`), lazily imported by
  `measure.mjs` only under `--mutation`.
- Several CI lanes pin Node below 22.18: `ci-tests.yml` `node-floor-compat`
  (22.14.0) and the containment-canary job (22.16.0),
  `gitnexus-review-agent.yml` (22.16.0), `gitnexus-skill-evolution.yml`
  (22.16.0). Under a 22.18 floor these run below the supported minimum.

## 3. Approach decision

Two ways to make installs warning-free:

- **(A) Pin Babel to 7** — keeps the floor at `>=22.0.0`; suppresses the
  warning without changing what the project supports. Requires a Dependabot
  ignore so the Babel 8 bump does not return.
- **(B) Raise the floor to 22.18+ and keep Babel 8** — chosen. `engines`
  becomes `^22.18.0 || >=24.11.0`, matching Babel 8 exactly, so the warnings
  vanish honestly and no Dependabot ignore is needed. Cost: a user-facing
  raise of the minimum Node (drops 22.0–22.17), which is why it moves the
  documented floor and the CI floor gate deliberately.

The `engines` string mirrors Babel 8's own constraint (`^22.18.0` = the
22.18-and-up 22.x line; `>=24.11.0` = the 24.x line that got the relevant
backport) so that no Babel-8 EBADENGINE can reappear on any Node the project
claims to support. `>=22.18.0` would be looser but would re-warn on Node 23.x
and 24.0–24.10, which Babel 8 excludes.

## 4. Proposed changes

| File | Change |
| ---- | ------ |
| `gitnexus/package.json` | `engines.node` `>=22.0.0` → `^22.18.0 \|\| >=24.11.0`; remove `@types/uuid` devDependency. Babel stays `^8.0.0`. |
| `gitnexus/package-lock.json` | Mirror both edits (engines + `@types/uuid` entry removed). Hand-applied to avoid npm-version `libc` metadata churn (local npm 10.9.2 strips the `libc` platform arrays a newer npm wrote; those drive musl/glibc optional-dep resolution and must be preserved). Verified consistent via `npm ci` exit 0. |
| `CONTRIBUTING.md` | Prerequisite floor `>=22.0.0` → `^22.18.0 \|\| >=24.11.0`. |
| `.github/workflows/ci-tests.yml` | `node-floor-compat` retargeted 22.14.0 → 22.18.0 (name, comment, pin, version assertion) so the floor gate guards the *new* minimum; containment-canary pin 22.16.0 → 22.18.0. |
| `.github/workflows/gitnexus-review-agent.yml` | Pinned Node 22.16.0 → 22.18.0. |
| `.github/workflows/gitnexus-skill-evolution.yml` | Pinned Node 22.16.0 → 22.18.0. |

CI lanes using `node-version: 22` (latest ≥22.18) or `24` are already at/above
the floor and unchanged. `CHANGELOG.md` and `package.json` `version` are
release-owned (per repo convention) and deliberately untouched.

## 5. Implementation sequence

1. `gitnexus/package.json` + `gitnexus/package-lock.json`: engines bump and
   `@types/uuid` removal (one atomic commit).
2. CI + docs: floor-gate retarget, the three pinned-lane bumps, CONTRIBUTING
   prerequisite (one atomic commit).

Both orderings leave the tree coherent; each is `detect_changes`-gated
(config/manifest files carry no indexed symbols → empty affected set).

## 6. Verification

- `npm ci` in `gitnexus/` exits 0 (lockfile ↔ package.json consistency after
  the hand-edit).
- On local Node 22.16.0 (now *below* the floor), the only EBADENGINE lines are
  the nine Babel 8 packages plus `gitnexus` itself, all reporting the identical
  `required: ^22.18.0 || >=24.11.0` — i.e. they satisfy together at ≥22.18 and
  vanish by construction. No other engine warning; no `@types/uuid`
  deprecation. (A true zero-warning run requires Node ≥22.18, unavailable in
  this sandbox; CI's ≥22.18 lanes are the authoritative check.)
- Mutation oracle single-fixture run
  (`measure.mjs --mutation --only=intra-control-branch --json`) exits 0 on
  Babel 8 with a fingerprint identical to the Babel 7 run — the bench consumer
  is unaffected.
- `npm run test:unit` passes.

## 7. Risks

- **User-facing floor raise** — dropping Node 22.0–22.17 is a support-policy
  change. Deliberate and the point of this PR; belongs in the release notes at
  release time (not edited here per CHANGELOG convention).
- **Lockfile hand-edit** — mitigated by the `npm ci` exit-0 consistency proof
  and by preserving `libc` platform metadata (musl/Alpine native resolution).
- **node-floor-compat** — its original #2372 failure mode (`module.registerHooks`
  ≥22.15 on a sub-22.15 floor) can no longer occur at a 22.18 floor; the gate
  is retained, retargeted to 22.18.0, to guard the new minimum generally.

## 8. Definition of Done

1. `gitnexus/package.json` `engines.node` = `^22.18.0 || >=24.11.0`; Babel at
   `^8.0.0`; `@types/uuid` absent.
2. `npm ci` exits 0; no `@types/uuid` deprecation; the only EBADENGINE lines on
   sub-floor Node are Babel 8 + gitnexus-self, all with the new required range.
3. Mutation oracle single-fixture run exits 0 on Babel 8.
4. `npm run test:unit` passes.
5. No CI lane pins Node below 22.18; `node-floor-compat` guards 22.18.0.
6. `CONTRIBUTING.md` floor updated; `CHANGELOG.md`/`version` untouched.
7. Diff limited to the six files above (+ this plan).
