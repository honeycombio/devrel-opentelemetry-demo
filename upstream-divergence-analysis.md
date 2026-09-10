# How far apart are we from upstream, really?

Measured 2026-09-09, `main` (`817c3caa`) against `upstream/main` (`fcedca78`).

**Short answer: the raw numbers look terrifying and mostly aren't. 93% of the
conflict volume is regenerable build output. What's actually hard is four
decisions, not 35,000 lines of merging. And you should merge, not rebase.**

## Scale of the drift

| | |
|---|---|
| merge-base | `e4743cf0`, 2025-11-19 — **~10 months old** |
| commits we're ahead | 281 |
| commits upstream is ahead | 755 |
| files we touched | 253 — **156 added, 97 modified, 0 deleted** |
| files upstream touched | 542 |

That 156-added / 0-deleted shape is the good news buried in the numbers: most of
our fork lives in *new* files, which don't conflict. Only 97 files are
modifications of upstream code, and only 72 of those were also modified upstream.

## What a real merge actually costs

Not a guess — `git merge-tree --write-tree main upstream/main` (a full merge with
no working tree touched):

```
CONFLICTED FILES: 84
  45 CONFLICT (content)
  30 CONFLICT (add/add)
   9 CONFLICT (modify/delete)
```

### 93% of the volume is regenerable — do not merge it

Our churn across the 72 modify/modify files is 35,287 lines. Split by kind:

```
generated code + lockfiles (regenerable): 32,684
hand-written (real review work):           2,603
```

The offenders are checked-in build output and lockfiles:

- `src/currency/build/generated/proto/demo.pb.h` — 11,327 ours / 17,120 theirs
- `src/currency/build/generated/proto/demo.pb.cc` — 5,019 / 17,548
- `src/frontend/package-lock.json` — 8,972 / 6,577
- `src/frontend/protos/demo.ts`, `*/genproto/oteldemo/demo.pb.go`,
  `demo_pb2.py`, `demo_pb2_grpc.py`, `*.grpc.pb.*`

**Approach: `git checkout --ours`/delete these during the merge, then regenerate.**
`docker-gen-proto.sh` is at repo root; lockfiles come back from `npm install`.
13 of the 84 conflicted files are in this bucket.

**Then gitignore them**, so this never costs us again. Committing
`src/currency/build/` in particular is pure self-harm at merge time.

### 30 of the 84 are shallow add/add collisions

Both forks independently grew `telemetry-schema/` (25 files) and
`src/telemetry-docs/` (4 files). These are **not** rival designs — the READMEs
are near-identical prose, so they share an origin. Actual drift:

- `telemetry-schema/`: 37 files, 260 insertions / 363 deletions
- `src/telemetry-docs/`: 6 files, 485 insertions — but 454 of those are a pinned
  `requirements.txt`. Real drift is ~31 lines.

Plus `CLAUDE.md`, which upstream also now has. Ours wins; theirs is worth reading
once for anything worth stealing.

## The four things that are genuinely hard

These are judgment calls. No merge strategy resolves them for you.

### 1. Attribute naming — we and upstream chose opposite directions

At the merge-base the repo was mid-migration. Since then the two forks finished
that migration in **opposite directions**:

| rev | `app.*` | `demo.*` |
|---|---|---|
| merge-base (2025-11-19) | 79 | 30 |
| **upstream/main** | **0** | **129** |
| **ours** | **221** | 34 |

Upstream completed the move to `demo.*`. We went the other way and roughly tripled
our `app.*` usage. It's concentrated in only 10 of the overlapping files, so it's
small to *merge* — but it's semantic, and it doesn't stop at `src/`:

- 26 files outside `src/` key off `app.*` — `telemetry-schema/` (16),
  `test/tracetesting/*`, planning docs
- **and our Honeycomb boards, SLOs, triggers, and saved queries, which live outside
  this repo entirely and won't show up in any grep**

So "just take upstream's names" silently breaks demo assets we can't see from here.
This is the decision to make deliberately and first, because it determines whether
dozens of hunks are "take theirs" or "keep ours".

### 2. Upstream deleted `src/product-reviews`

`e6cae501 [cleanup] Remove product-reviews service (#3587)`. It is also our single
largest hand-written divergence (737 lines of our churn). Merging surfaces this as
9 modify/delete conflicts across `product_reviews_server.py`, its `Dockerfile`,
`requirements.txt`, and generated protos. Decision: do we keep carrying a service
upstream has dropped?

### 3. `src/postgres` → `src/postgresql`

`4d6fd2f4 rename postgres to postgresql (#2867)`. Mechanical, but our order-store
tooling and docs reference the old path, and `src/postgres/init.sql` (17 ours / 123
theirs) has diverged. Note upstream also landed
`562ff1c1 [product-catalog] use database for products (#2859)`, so the DB's role
changed too — this is more than a rename in practice.

### 4. Compose was restructured

`d72cbb54 feat(docker): modular Docker Compose with layered -f files (#3229)`.
Upstream now has 7 layered `compose*.yaml` files; we still have monolithic
`docker-compose.yml` + `docker-compose.minimal.yml` (4 files, different model).
Our `.env` (11 ours / 116 theirs) and `.github/workflows/checks.yml` (11 / 210)
move with it.

## Recommendation: merge, don't rebase

Rebasing replays **281 of our commits** against 755 commits of upstream change.
You'd hit the same generated-protobuf conflict dozens of times, once per commit
that touched it, and every intermediate state has to be conflict-resolved even
though nobody will ever check it out.

A single merge commit resolves each file **once**: 84 files, of which ~13 are
delete-and-regenerate and ~30 are shallow, leaving roughly **40 files of real work
plus the 4 decisions above**. That is a couple of focused days, not a quarter.

Suggested order:

1. Decide the attribute-naming question (#1) — everything else is cheaper once it's settled.
2. Decide product-reviews' fate (#2).
3. `git merge upstream/main`; immediately blow away and regenerate all generated/lockfile conflicts.
4. Adopt upstream's `telemetry-schema/` + `telemetry-docs/` structure, re-adding our attributes.
5. Work the ~40 hand-written files. The top ones by churn: `locustfile.py` (474),
   `checkout/main.go` (152), `accounting/Consumer.cs` (145), `payment/charge.js` (129),
   `CartService.cs` (81), `pb/demo.proto` (70).
6. Take upstream's compose restructure wholesale and re-layer our devrel bits on top.

## How to not be here again

- **Gitignore generated output and stop committing `src/currency/build/`.** This alone
  removes 93% of the apparent conflict volume.
- **Merge upstream quarterly, not annually.** A 10-month gap is what turned four
  decisions into an 84-file event.
- **Keep pushing our fixes upstream.** Every accepted PR is divergence deleted rather
  than carried — see `upstream-payment-flagd-analysis.md` for one that's ready to go.
- **Prefer adding files over modifying them** where the demo allows. We're already
  good at this (156 adds vs 97 mods); it's why this is tractable at all.

## Reproducing these numbers

```bash
MB=$(git merge-base main upstream/main)
git rev-list --count $MB..main            # our commits
git rev-list --count $MB..upstream/main   # theirs
git diff --name-status $MB main | awk '{print $1}' | sort | uniq -c
git merge-tree --write-tree --name-only main upstream/main   # dry-run merge
git grep -hoE "\"app\.[a-z_.]+\"" main -- src/ | wc -l       # naming split
```

Note: `git show <sha>:<path>` gets mangled in the sandboxed shell (the `:path`
suffix is stripped and you get the commit instead of the blob). Use
`git grep ... <rev> -- <path>` or a branch name instead of a raw SHA.
