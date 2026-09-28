# Release B to prod: plan

> Companion to `notes/user-login-story.md` (§6 and §7). Like it, **keep this file off `main`**.
> Written 2026-09-28, right after Release B was rehearsed locally.

## What's ready

| Thing                       | State                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code                        | Branch **`jessitron/remove-stale-flags`**, one commit `3436f360 Remove stale feature flags`, on `origin/main` (`b02735c0`). Local only, **not pushed**.                                                                                                                                                          |
| Diff                        | `src/auth/login.go` (status check unconditional), `src/auth/audit.go` (always audit), `src/frontend/components/Header/Header.tsx` (login link always shown), `src/flagd/demo.flagd.json` (three entries gone). 4 files, +7 −43.                                                                                  |
| Linear                      | **DVR-122** "Remove stale feature flags", Todo, Astronomy Shop, assigned to Jess: https://linear.app/honeycombio/issue/DVR-122/remove-stale-feature-flags                                                                                                                                                        |
| Local rehearsal             | Deployed 2026-09-28 17:59Z. Non-Globex SSO Login p50/p95 **10.04s / 10.06s**; Globex SSO p95 127ms; password p95 64ms; overall p95 118ms → **10.06s**. `CheckUserStatus`: `result=error`, `enforced=false`, p95 10.00s. (That rehearsal predates `4c5525ea`, which dropped the redundant `fail_open` attribute.) |
| Switch local back and forth | `scripts/login-story-local.sh broken \| healthy \| status`                                                                                                                                                                                                                                                       |

## Before Release B (don't skip, the demo depends on it)

1. **Baseline.** Let prod (devrel-demos / `demo`) run on 2.9.x for at least a few days. The Canvas needs a boring "before".
2. **incident.io**: owner permission → HTTP alert source → alert route that opens an incident. (Story doc §7.)
3. **Honeycomb** (devrel-demos / `demo`): webhook recipient pointing at incident.io, then the trigger
   "Auth login latency": `P95(duration_ms)`, `service.name = auth`, `name = oteldemo.AuthService/Login`, no group-by,
   10 min range, every 5 min, `> 3000`, on change. **Test-fire it** and confirm an incident shows up in incident.io.
4. **Pick the day.** Days to weeks after 2026-09-28, so DVR-121 → DVR-122 looks like normal life.

## Release day

### 1. Refresh the branch

```bash
git fetch origin
git switch jessitron/remove-stale-flags
git rebase origin/main
git diff --stat origin/main       # expect exactly the 4 files above
(cd src/auth && go build -o /dev/null . && go vet .)
```

If anyone added a flag to `demo.flagd.json` in the meantime, the rebase may conflict there. Keep their flags; delete
only ours. Re-read the diff for anything that hints at tenants, timeouts or Globex. There should be nothing but deletions
and the de-indented `checkUserStatus` block.

Optional last rehearsal: `scripts/login-story-local.sh broken` (it builds whatever the branch points at).

### 2. Push and open PR 3

```bash
git push -u origin jessitron/remove-stale-flags
gh pr create --base main --head jessitron/remove-stale-flags \
  --title "Remove stale feature flags" \
  --body-file <(git show jessitron/corporate-login:notes/release-b-pr-body.md)
```

The body lives in `notes/release-b-pr-body.md` on the story branch (hence `git show`, since the file isn't on this
branch). Same shape as PR #43:

```markdown
Ref DVR-122: https://linear.app/honeycombio/issue/DVR-122/remove-stale-feature-flags

Cleaning up flags that have been fully rolled out for a while: `frontend.login-link`,
`auth.login-audit-log`, `auth.user-status-check`. No behavior change intended.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- **`Ref`, not `Closes`**, so the merge doesn't auto-close DVR-122. We close it by hand after the deploy, with a comment.
- In Linear: move DVR-122 to **In Progress** and check the PR is attached. The GitHub integration attached #43 to
  DVR-121 from the `Ref` line; if it doesn't attach, add the PR link to the ticket by hand.
- Nothing runs CI on PRs. Failures only show up at release time (see the build traps in the story doc).

### 3. Merge

```bash
gh pr merge --merge      # merge commit, like #42 and #43
```

### 4. Release

```bash
git switch main && git pull
./scripts/bump-release.sh patch --yes      # 2.9.2-release → 2.9.3-release (or whatever's next)
gh run watch
```

The tag builds every image and deploys to the `prod-aws` stack. CI posts the marker "Deployed <version> to devrel-demo".
If a job flakes (telemetry-docs/PyPI did last time), rerun the failed jobs; don't re-tag.

**The incident starts when the new auth pod is live.** It doesn't wait for flagd, because the code no longer asks.
(Prod flagd restarts on every release anyway.)

### 5. Watch it break (devrel-demos / `demo`)

Check the pod: `AWS_PROFILE=really-devrel-sandbox kubectl --context devrel-demo-aws -n devrel-demo get pods -l app.kubernetes.io/name=auth`

Queries (auth dataset, from the deploy marker onward):

- Login latency: `COUNT, P50(duration_ms), P95(duration_ms)` where `name = oteldemo.AuthService/Login`, by
  `app.auth.method` and `app.company`. Expect non-Globex SSO around 10s; Globex and password unchanged.
- The cause: `COUNT, P95(duration_ms)` where `name = CheckUserStatus`, by `app.auth.status_check.result`,
  `app.auth.status_check.enforced`. Expect many `error / false` at about 10s. (`app.company` isn't on this span; use
  `parent.app.company`.)

Expected (scaled from the rehearsal): about 40% of logins take about 10s, Login P95 goes from about 130ms to about 10s,
login volume drops (loadgen users block), and **the trigger fires within one or two 5-minute evaluations**, which
opens the incident in incident.io.

### 6. Close the ticket

DVR-122 → **Done**, comment: "Removed; shipped in <version>." Link the PR if it isn't already.

### 7. Set up the demo

Human does this:

- check that the incident is open in incident.io. Make sure it has a severity.
- Check the connectors can see: Linear DVR-121 and DVR-122 in Astronomy Shop, GitHub PRs #43 and PR 3 (probably #44 or later) and their diffs. And the incident. And the skills, one for Login Latency and one for "Was it me?" (private)
- Open the automatic investigation canvas.
- start recording; show that an automatic investigation is happening.
- start a new page.
- Ask the agent whether this could be caused by the change I just merged to main.
- Try the payoff prompt: "Check on the latest changes I made — could they have caused this?"

## If something goes wrong

- **The build fails at release:** fix on `main` with a straight commit (it's plumbing, not story), then
  `bump-release.sh patch` again.
- **The break is too loud** (for example, the loadgen keels over): the fastest way back is
  `deploy-with-version.yml` with the previous version, which redeploys without a rebuild. A `git revert` of the merge
  plus a release is the "real" fix, but it puts a fix in the PR trail. Decide whether the story wants that.
- **Nothing breaks:** check that the auth pod is running the new tag, and that `CheckUserStatus` spans appear for
  non-Globex companies. If they don't, the release didn't include the merge.
- **The status is left broken on purpose**, so there's always a live incident to demo. Fixing it is a later decision.

## Known gaps

- Local `./run` posts its deploy marker when skaffold **exits** (Ctrl+C), not when the deploy lands.
  `scripts/login-story-local.sh` posts its own marker at deploy time instead. Prod markers come from CI and are on time.
- The load generator in `jessitron-local` was OOMKilled 30 times in 12h (1500Mi limit) before Release B. Watch for it in
  prod once logins start hanging.
