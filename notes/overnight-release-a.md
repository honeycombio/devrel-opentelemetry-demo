# Overnight run: Release A, from local to prod

Agreed with Jess on 2026-09-27 before she went to sleep. This file **overrides** the
"Do NOT" list in the original overnight goal where the two conflict. The design and the
commit table live in `notes/user-login-story.md` (§6). Don't re-open decisions there.

## End state by morning

- Release A is **live in prod** (`devrel-demo`), and Login telemetry is **accumulating** as
  baseline.
- PR 1 "Corporate login" and PR 2 "Globex: verify employee still active after SSO" are
  **opened and merged** by Claude (as jessitron via `gh`).
- M1–M4 are pushed straight to `main`, in the landing order.
- There is one release tag, a minor bump.
- Linear ticket 1 exists in the DevRel team, is linked to PR 2, and is closed.
- `notes.md` holds the log (see "Morning report").

## What Jess authorized (and what she didn't)

Authorized:
- Push to `main` (only the M* commits, and only in the landing order).
- `gh pr create` / `gh pr merge` for PR 1 and PR 2.
- `./scripts/bump-release.sh minor --yes`, which pushes the tag. CI builds the images and
  runs Pulumi against `prod-aws`.
- The Linear MCP: anything in the **DevRel** team.
- **Read-only** looks at prod: Honeycomb queries on the devrel-demos team / `devrel-demo`
  env, and `kubectl get`/`logs` in `devrel-demo`
  (`AWS_PROFILE=really-devrel-sandbox kubectl --context devrel-demo-aws`).

Still off limits:
- Anything from Release B: PR 3, removing flags, and Linear ticket 2.
- Honeycomb triggers and recipients, and incident.io.
- `kubectl` writes to any namespace except `jessitron-local`.
- Force-push. Hand-running `pulumi up`. Hotfixing prod.
- Merging `jessitron/corporate-login` itself into main. It carries these notes. See
  "Landing" below.

**If prod fails:** stop, capture the CI run URL, pod status and logs, and write it up.
Jess looks at it in the morning. Don't hotfix prod or re-tag blind.

## Phase 0: before the first commit

- [ ] Kill stale skaffold processes (`ps aux | grep skaffold`).
- [ ] Docker is running. `AWS_PROFILE=devrel-sandbox aws sts get-caller-identity` → account
      657166037864. Always pass `AWS_PROFILE=devrel-sandbox` to `./run`, because
      `.skaffold.env` names Martin's profile.
- [ ] Run `scripts/local-honeycomb-destination.sh`. Expect `modernity` /
      `devrel-demo--local-`, via the `honeycomb-devrel-demo` MCP.
- [ ] Linear MCP answers (list teams and find DevRel). If it isn't authorized, skip every
      Linear step, note it, and keep going. Linear isn't on the critical path.
- [ ] Suggested to Jess: run `caffeinate -dims` so the Mac doesn't sleep mid-run.

## Phase 1: build and verify locally (branch `jessitron/corporate-login`)

Go row by row through `user-login-story.md` §6: A1, A2, M1, A3, M2, A4, A5, M3, A6, M4.
- One commit per row. Each commit is story (A*) or plumbing (M*), never both.
- A* code, comments and commit messages stay ordinary: no hanging, timeouts, blackholes,
  incidents, or "the story".
- After each commit:
  1. Run `AWS_PROFILE=devrel-sandbox ./run <services from the table>` in the background.
     Wait for `Port forwarding service/frontend-proxy … Press Ctrl+C to exit`, then kill the
     run before the next one.
  2. Do that row's **Verify** in Honeycomb (local env). Record the SHA, the result, and one
     trace ID.
  3. Push the branch (`git push -u origin jessitron/corporate-login`) so the work survives
     a crash.
- If a row fails, fix it before moving on. If a row is truly blocked, continue only with
  later rows that don't depend on it. Almost everything depends on A3 and M2, so a stuck
  A3/M2 means **no prod deploy tonight**. Write it up and stop.

Commits that are neither A* nor M* (these notes, `notes.md`) live on this branch only and
never go to main or into a PR.

## Phase 2: local dress rehearsal (before anything lands)

This runs before prod, so any surprise turns up while it's still cheap.
1. Record "before" numbers from the local env over the last ~15 minutes:
   - non-Globex SSO Login p95,
   - overall Login p50 (and p95),
   - Globex Login p95.
2. Port-forward flagd-ui. Set `auth.user-status-check` to default `on` and remove the
   targeting.
3. Wait about 15 minutes, then take the same numbers "after". Expected results:
   - Non-Globex SSO p95 is about 10s.
   - `CheckUserStatus` shows an `i/o timeout` error with `fail_open=true`, and the login
     still succeeds.
   - Overall p50 barely moves.
4. Restore by **restarting the flagd pod** in `jessitron-local`. Confirm that non-Globex SSO
   logins no longer have `CheckUserStatus`.

If the rehearsal doesn't produce the expected shape, write it up and **don't land**. Prod
would still get a working release, but the story wouldn't work.

## Phase 3: land on main, in order

Build landing branches from the verified commits. Don't rebase the work branch itself.
1. **PR 1:**
   - Make branch `jessitron/corporate-login-pr1` from `origin/main` and cherry-pick
     A1–A5.
   - `gh pr create` with the title "Corporate login" and an ordinary description of the
     feature (the login page, the auth service, SSO and password, and the two flags).
   - Wait for any required checks, then `gh pr merge --merge` (not squash: the commits are
     the story).
2. **Plumbing:** fast-forward local `main` to `origin/main`, cherry-pick M1, M2, M3, and
   `git push origin main`.
3. **Linear ticket 1** in DevRel: "Globex: verify employee still active after SSO". Use the
   body from `user-login-story.md` §8.
4. **PR 2:**
   - Make branch `jessitron/globex-status-check` from `origin/main` and cherry-pick A6.
   - `gh pr create` with the title "Globex: verify employee still active after SSO". The
     body links the Linear ticket, and it's ordinary: per-tenant configurable, Globex
     enforces, shipped behind `auth.user-status-check`.
   - Merge it.
   - Link the PR on the ticket.
5. **Plumbing:** cherry-pick M4 onto main and push.
6. Check that `main` builds the same tree as the verified work-branch tip, minus the notes:
   `git diff origin/main jessitron/corporate-login -- . ':!notes' ':!notes.md'` should be
   empty.

Between steps, `main` briefly has SSO without mocks. That's harmless, because nothing
deploys until the tag.

## Phase 4: deploy to prod

1. `./scripts/bump-release.sh minor --yes`.
2. Watch `release-devrel.yml` (`gh run watch`) through the image builds and the Pulumi
   deploy.
3. Read-only check of `devrel-demo`: the `auth` pod (with the `sso-mocks` sidecar) is
   Running, and postgres restarted with the new schema. Also check Kafka's restart count,
   since a restart empties the order table.
4. After ~15–30 minutes, in Honeycomb (devrel-demos team / `devrel-demo` env), repeat the
   M3/M4 checks:
   - Login count by `app.company`: Globex is about 35%.
   - Non-Globex logins by method: about 40% password.
   - Login p95 is under 300ms.
   - Globex has `CheckUserStatus` with about 4% `user_not_current`.
   - Non-Globex logins have no `CheckUserStatus`.
5. Close Linear ticket 1 with the comment "Shipped behind `auth.user-status-check`, rolled
   out." Note the **baseline start time** (when the release went live).

## Decisions made in Jess's place (list more as they come up)

- `notes/user-login-story.md` does **not** go on main for now. It describes the whole
  trick, and main is what the GitHub connector searches. It stays on
  `jessitron/slow-login-story` and this work branch. Revisit after the demo is recorded.
- One tag, after M4, not one per row. Prod never sees a partial feature.
- PR merges use merge commits, so the individual A* commits stay readable in the PR.

## Morning report: `notes.md` (git add -f, commit on this branch, push)

- For every commit: SHA, verify result, and a local trace ID. Also the landed SHAs on main,
  the PR URLs, the tag, and the CI run URL.
- Every assumption made in place of asking Jess.
- Anything that diverged from the plan, and anything that turned out surprising.
- Dress rehearsal: non-Globex SSO p95 and overall p50, before and after.
- Prod: the time the release went live (baseline start), the first prod numbers, and any
  failure with its logs.
- End with `result:` (or `failed:`) as usual.
