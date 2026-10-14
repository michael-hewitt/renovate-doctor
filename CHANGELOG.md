# Changelog

Callers pin a tag (`uses: michael-hewitt/renovate-doctor/.github/workflows/renovate-doctor.yml@v0.1.0`); the
workflow checks out its scripts and skill at that tag's commit, so a caller runs exactly the version it pinned
until it moves the pin. Every change a caller could notice gets a new tag and an entry here.

## v0.1.7 - 2026-10-14

- The gate reads job logs with `gh api --allow-escape-sequences`: `gh` 2.97 and later (GitHub-hosted
  runners have 2.102) refuse to print a response with terminal escape sequences, which every job log has,
  and the first dry run on a GitHub-hosted runner spent 35 minutes retrying that refusal before launching
  the agent with no logs. A `gh` too old for the flag (a self-hosted runner's 2.45) gets a plain call
  instead. The adapter no longer retries a refusal by `gh` itself, and the log wait now continues only
  for a log that is not published yet (a 404); any other failure ends the wait for that job.

## v0.1.6 - 2026-10-14

- The triage and lift jobs check the caller out with `persist-credentials: false`, and the PR head is fetched
  with the job token passed to that one `git fetch`. Before, the persisted job token won over the Claude App
  token in the remote URL, so the first caller's first live fix was pushed as `github-actions[bot]` and GitHub
  left its CI runs at "action required" with no jobs; auto-merge would have waited forever. Pushes now go out
  as the App (`claude[bot]`), whose pushes get CI.
- The gate's two-attempt cap also counts the fixes recorded in renovate-doctor's own `merged` comments, so a
  Renovate rebase that drops the fix commits (with the agent's author in `gitIgnoredAuthors`, which the README
  now recommends) does not reset it. With the cap reached that way, the escalation says the fixes were
  rebased away and are in the comments.
- Skill: do not wait for CI on the pushed head (a pending check is `merged`'s normal state), never run
  anything in the background, and write the outcome file before stopping. The first live fix run waited for
  Chromatic in a background loop, stopped, and left no outcome file, which the report job escalated as
  designed. The comment now says whether Renovate will keep rebasing the branch, read from the project's
  `gitIgnoredAuthors`.

## v0.1.5 - 2026-10-13

- New `effort` input, default `high`, passed to claude-code-action as `--effort` for the triage and lift
  agents (Claude Code's levels: `low`, `medium`, `high`, `xhigh`, `max`). Before, Claude Code chose its own
  default.

## v0.1.4 - 2026-10-12

- The agent reads Actions runs and the PR's checks with the job's token (`RENOVATE_DOCTOR_ACTIONS_TOKEN`):
  the Claude App token cannot (403 "Resource not accessible by integration" on `gh run list`, `gh pr checks`
  and `statusCheckRollup`, seen in the first caller's dry run against a live failure). **Callers must grant
  `checks: read` and `statuses: read`** on the job alongside the existing permissions; the README caller
  shows them. In a dry run those reads fail, as the token is withheld there, and the agent says so.

## v0.1.3 - 2026-10-12

- New `model` input, default `claude-opus-5-5`, passed to claude-code-action as `--model` for the triage and
  lift agents. Before, the action chose its own default, which the first caller's dry run showed to be
  Sonnet.

## v0.1.2 - 2026-10-12

- `gh api --paginate` is used without `--slurp`, which the first caller's self-hosted runner's `gh` predates
  (it is from 2.49): the adapter splits the concatenated pages itself. Before, every gate run failed at its
  first paginated call ("unknown flag: --slurp") and reported the `failed` outcome.
- A gate error keeps only its first two lines (the command and the CLI's own first line), so a usage dump
  no longer fills the email and the step summary.
- The Gate step logs the runner's `gh` version first.

## v0.1.1 - 2026-10-12

- A caller forwarding its `workflow_dispatch` inputs must pass `pr` and `run_id` as
  `${{ fromJSON(inputs.pr || '0') }}`: a dispatch's `number` input is a string in the `inputs` context, and
  the reusable workflow's `type: number` inputs reject a string before any job exists (the run fails with
  "This run likely failed because of a workflow file issue" and no jobs). The README's caller, the input
  descriptions and `docs/architecture.md` now say so; the workflow's inputs are unchanged.
- Gate: a manual run's `run_id` is checked against the PR's branch for every event, not only
  `workflow_dispatch`, so a run from another branch is refused however the workflow was started.
- Internal: the JavaScript is type-checked with `tsc --checkJs`, and a self-test workflow calls the reusable
  workflow from this repository on every pull request and on manual dispatch.

## v0.1.0 - 2026-10-12

The first release ([#1](https://github.com/michael-hewitt/renovate-doctor/issues/1)).

- The reusable workflow (`.github/workflows/renovate-doctor.yml`), with two modes: `triage`, run on
  `workflow_run` when a caller's CI fails, and `lift`, run monthly.
- Triage: the gate (six conditions, the network-failure deferral to a caller's rerun automation, the two-attempt
  cap), the agent's skill with its five outcomes (`merged`, `rerun`, `declined`, `escalated`, `skipped`), the
  transcript artifact, and the one plain-text email through Mandrill, or silence, sent from a separate report
  job on a GitHub-hosted runner that alone holds the mail key.
- Lift: expired dated holds removed with their condition tests in one auto-merged PR, and lifted updates
  Renovate has not reopened ticked on the Dependency Dashboard.
- Dry runs through `workflow_dispatch` for both modes.
