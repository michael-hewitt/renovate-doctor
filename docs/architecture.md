# Architecture and contracts

The design is in [issue #1](https://github.com/michael-hewitt/renovate-doctor/issues/1). This file fixes the
interfaces between the pieces so they can be built and changed independently: file layout, workflow inputs,
the gate's outputs, the outcome file, the scripts' environment, and the agent's conventions on GitHub. The
README is the user-facing description; when the two disagree, fix both.

## One rule for drawing lines

Generic things live here and know nothing about any project; every project-specific value arrives as a
workflow input or an environment variable. If a second project would need the same thing, it is an input
with a sensible default; if only one project would, it goes in that project's notes file. Do not add an
input until a caller needs it.

## Layout

```
.github/workflows/renovate-doctor.yml   the reusable workflow (workflow_call)
.github/workflows/ci.yml                this repository's own tests and format check
scripts/gate.mjs                        triage: launch or skip, and why
scripts/report.mjs                      triage: the email (or silence) after the agent
scripts/lift.mjs                        lift: remove expired holds, open the config PR
scripts/dashboard-recreate.mjs          lift: tick "recreate" on the Dependency Dashboard for holds lifted earlier
lib/network_signature.mjs               the shared network-failure signature
lib/github.mjs                          `gh api` wrapper; every GitHub call goes through an injectable adapter
lib/mandrill.mjs                        the mail sender (one provider behind a small interface)
lib/outcome.mjs                         read and validate the outcome file
lib/renovate_config.mjs                 parse renovate.json, find and remove expired dated holds
lib/logs.mjs                            fetch a failed run's job logs, with the publish-lag wait
skills/renovate-doctor/SKILL.md         the agent's procedure, readable by a person and runnable by hand
test/*.test.mjs, test/fixtures/         vitest; fixtures are real event payloads and API responses, trimmed
docs/architecture.md                    this file
README.md  CHANGELOG.md  LICENSE (MIT)  package.json  pnpm-lock.yaml  .nvmrc  .prettierrc  .gitignore
```

Runtime: Node 24 (`.nvmrc`), ES modules, **zero runtime dependencies** (vitest and prettier are dev only);
the scripts run on the caller's runner straight from a checkout of this repository, so nothing is installed
there. The `gh` CLI is on PATH (GitHub-hosted runners have it; self-hosted ones install it). All GitHub reads
and writes go through `lib/github.mjs`, whose default adapter shells out to `gh api` and which tests replace
with a fake. All outside calls retry a few times with a growing pause: a self-hosted runner's network can
stall for seconds.

Style: prettier with single quotes and `printWidth: 120`; `pnpm run format:check` is part of CI. Comments
explain why, in full sentences; file headers say what the script is for and which environment it reads.

## The reusable workflow

`on: workflow_call`. The caller's event payload is `github.event` inside the called workflow, so the gate reads
`$GITHUB_EVENT_PATH` directly. The workflow checks out **this repository at `${{ job.workflow_sha }}`** (the
commit of the reusable workflow file, i.e. the tag the caller pinned) into `.renovate-doctor` inside the
caller's checkout and adds that path to the caller checkout's `.git/info/exclude`, so the agent's `git status`
stays clean.

### Inputs

| input               | type    | default            | meaning                                                                                                                                                              |
| ------------------- | ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | string  | `triage`           | `triage` or `lift`. The caller computes it from its event (`schedule` → `lift`).                                                                                     |
| `runs_on`           | string  | `"ubuntu-latest"`  | JSON for `runs-on` (a string or an array), used as `runs-on: ${{ fromJSON(inputs.runs_on) }}`.                                                                       |
| `package_manager`   | string  | `npm`              | `npm` or `pnpm`. With `pnpm` the workflow runs `pnpm/action-setup` (the version from `packageManager`, `dest: ${{ runner.temp }}/setup-pnpm`).                       |
| `node_version_file` | string  | `.nvmrc`           | Passed to `actions/setup-node`.                                                                                                                                      |
| `install`           | string  | by package manager | `npm ci` or `pnpm install --frozen-lockfile`.                                                                                                                        |
| `typecheck`         | string  | `''`               | Empty means there is no typecheck step.                                                                                                                              |
| `test`              | string  | by package manager | `npm test` or `pnpm test`.                                                                                                                                           |
| `service_setup`     | string  | `''`               | Run before install, in the caller's checkout; may write to `$GITHUB_ENV` (a Postgres container exporting `PGPORT`, say). A reusable workflow cannot vary `services`. |
| `service_teardown`  | string  | `''`               | Run `if: always()` after the agent.                                                                                                                                  |
| `email_to`          | string  | required           | Where the report goes.                                                                                                                                               |
| `email_from`        | string  | required           | The sender address (must be a sender Mandrill accepts for the key).                                                                                                  |
| `email_from_name`   | string  | `renovate-doctor`  | The sender's display name.                                                                                                                                           |
| `notes_file`        | string  | `''`               | Repository-relative path of the project-notes file the agent reads after the skill.                                                                                  |
| `rerun_workflow`    | string  | `''`               | Name of a rerun automation to defer to. When set, a first-attempt failure whose log matches the network signature is left alone.                                     |
| `pr`                | number  | `0`                | Manual runs: the PR to triage.                                                                                                                                       |
| `run_id`            | number  | `0`                | Manual runs: the failed run to triage; `0` means the latest failed runs on the PR's head.                                                                            |
| `dry_run`           | boolean | `false`            | Nothing is pushed, commented, merged, rerun or opened; the gate reports its verdict but does not stop the agent; the report is printed, not sent.                    |
| `timeout_minutes`   | number  | `60`               | The agent job's timeout.                                                                                                                                             |

Secrets, declared on `workflow_call` and named explicitly by callers (`secrets: inherit` is only documented
for callers in the same organisation, and this repository is not in the caller's): `CLAUDE_CODE_OAUTH_TOKEN`
(required), `MANDRILL_API_KEY` (required). The agent step never sees `MANDRILL_API_KEY`.

Permissions the caller grants: `contents: write`, `pull-requests: write`, `issues: write`, `actions: write`
(to rerun jobs), `id-token: write` (claude-code-action). Concurrency is the caller's: one group per Renovate
branch, **queued, not cancelled** - a run that arrives after Renovate rebased is dropped by the gate (head
moved) rather than by cancelling an agent mid-work, and GitHub keeps at most one pending run per group.

### Triage job

1. Check out the caller at the PR head (`fetch-depth: 0`, token with write), then this repository.
2. `actions/setup-node` (+ `pnpm/action-setup` when `package_manager` is `pnpm`).
3. **Gate**: `node .renovate-doctor/scripts/gate.mjs` (step id `gate`). Always exits 0; its decision is in
   `$GITHUB_OUTPUT`.
4. If `launch == 'true'`: `service_setup`, then `install`.
5. The agent: `anthropics/claude-code-action@v1` with `claude_code_oauth_token`,
   `claude_args: --allowedTools "Bash,Edit,Write,Read,Glob,Grep"`, and the prompt below. Step id `agent`,
   `continue-on-error: true` is **not** used; the report step runs `if: always()`.
6. Upload the transcript (`steps.agent.outputs.execution_file`) as artifact `renovate-doctor-transcript-<run_id>`,
   30 days, `continue-on-error: true`.
7. `service_teardown`, `if: always() && inputs.service_teardown != ''`.
8. **Report**: `node .renovate-doctor/scripts/report.mjs`, `if: always() && (steps.gate.outputs.launch == 'true' || steps.gate.outputs.outcome != '')`.

The prompt (from the workflow, not the skill) says: read `.renovate-doctor/skills/renovate-doctor/SKILL.md`
first and follow it exactly; then read `<notes_file>` if given; the PR number, head SHA and branch; the failed
run ids and where their logs are (`$RUNNER_TEMP/renovate-doctor/logs/<run_id>.log`, written by the gate);
the install, typecheck and test commands; the number of fix attempts already on the branch; whether this is
a dry run; the outcome file path; and the rerun-workflow name if any.

### Lift job

1. Check out the caller's default branch and this repository; setup node.
2. `node .renovate-doctor/scripts/dashboard-recreate.mjs`: for every hold lifted by a lift PR merged in the
   last 60 days whose package has no open Renovate PR, tick the Dependency Dashboard checkbox naming it.
3. `node .renovate-doctor/scripts/lift.mjs`: remove expired holds and open the config PR with auto-merge.
4. Email (through `report.mjs` in lift mode): one email when a PR was opened or the step failed; none when
   nothing had expired.

## Gate contract (`scripts/gate.mjs`)

Environment: `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GH_TOKEN`, `RUNNER_TEMP`,
`INPUT_PR`, `INPUT_RUN_ID`, `INPUT_DRY_RUN` (`true`/`false`), `RERUN_WORKFLOW`, `GITHUB_OUTPUT`.

Decision, in order; the first failing condition is the reason:

1. **failure**: the triggering run concluded `failure` (`workflow_run`); for a manual run, the chosen run (or
   at least one run on the head) concluded `failure`.
2. **renovate**: the head branch starts with `renovate/` and the PR's author is `renovate[bot]`.
3. **open**: exactly one open PR has that head branch, and its head SHA equals the run's head SHA (for a manual
   run with `run_id`, the run's head may be older than the PR's; this is reported and, outside dry run, skips).
4. **not handled**: no PR comment carries the marker `<!-- renovate-doctor sha=<head sha> -->`.
5. **not the rerun automation's turn**: when `RERUN_WORKFLOW` is set and the run's `run_attempt` is 1 and the
   failed log matches the network signature, skip (the rerun automation acts first; this runs on attempt 2).
   The log fetch waits for GitHub to publish it, up to about four minutes, as a project's rerun workflow would.
6. **attempts left**: fewer than two commits on the PR are by anyone other than `renovate[bot]`. Two or more
   means `launch=false`, `outcome=escalated`, `summary=fix attempts exhausted ...` - the report step emails
   and comments on the gate's behalf.

In **dry run** every condition is evaluated and printed, `verdict` carries the would-be decision, and `launch`
is `true` whenever the PR and run could be resolved at all, so a rehearsal can target a closed PR or an old
failed run.

Outputs (`$GITHUB_OUTPUT`): `launch` (`true`/`false`), `reason` (one line), `verdict` (dry run only),
`outcome` (`escalated` or empty), `summary` (for an outcome the gate produced), `pr_number`, `pr_url`,
`pr_title`, `head_sha`, `head_branch`, `failed_run_ids` (comma-separated), `attempts` (fix attempts already
on the branch). The gate also writes each failed run's failed-job logs (last 600 lines per job) to
`$RUNNER_TEMP/renovate-doctor/logs/<run_id>.log` for the agent.

## Outcome file (`$RUNNER_TEMP/renovate-doctor/outcome.json`)

Written by the agent, read by the report step. `lib/outcome.mjs` validates it.

```json
{
  "outcome": "merged | rerun | declined | escalated",
  "classification": "unrelated | fixable | not-takeable | needs-human",
  "summary": "One paragraph, plain text, written for the email: what failed, why, what was done.",
  "mention": false,
  "links": { "config_pr": "https://github.com/owner/repo/pull/123" }
}
```

`mention: true` on `merged` or `rerun` asks for an email anyway. `links` holds only what exists; the PR and
run links come from the workflow, not the agent. `merged` means auto-merge is enabled and the agent's fix
passed typecheck and tests locally; the merge itself waits for CI.

## Report contract (`scripts/report.mjs`)

Environment: `REPORT_MODE` (`triage`/`lift`), `OUTCOME_FILE`, `AGENT_OUTCOME` (the agent step's `outcome`:
`success`/`failure`/`cancelled`/`skipped`), `GATE_OUTCOME`, `GATE_SUMMARY`, `GATE_REASON`, `DRY_RUN`,
`PR_NUMBER`, `PR_URL`, `PR_TITLE`, `HEAD_SHA`, `RUN_URL`, `GITHUB_REPOSITORY`, `GH_TOKEN`, `EMAIL_TO`,
`EMAIL_FROM`, `EMAIL_FROM_NAME`, `MANDRILL_API_KEY`; for lift: `LIFT_OUTCOME`, `LIFT_PR_URL`, `LIFT_SUMMARY`.

Rules: no email for `merged` or `rerun` without `mention`; otherwise one plain-text email. No outcome file
and an agent step that failed or was cancelled → outcome `failed` ("the run failed", with the run link); no
outcome file and a successful agent step → `escalated` ("the agent wrote no outcome"). When the gate produced
the outcome (attempts exhausted) the report also posts the PR comment, with the sha marker, since no agent
ran. Subject: `[renovate-doctor] <outcome>: <PR title>`; body: the summary, then `PR:`, `Run:` and, when
present, `Config PR:` links, then one line naming the repository. Dry run prints `Subject:` and the body to
stdout and sends nothing. A refused send fails the step (the email is the product of a non-merged run).

## Lift contract (`scripts/lift.mjs`, `lib/renovate_config.mjs`)

A dated hold is a package rule with `"enabled": false` whose `description` contains `remove after YYYY-MM-DD:`
(the same marker form as a removal-marker TODO, so both read the same). `removeExpiredRules(text, today)`
returns `{ text, removed: [{ packages, date, description }], malformed: [...] }`; the returned text keeps
two-space JSON formatting; a rule whose date is not a valid ISO date is reported as malformed and left alone;
rules without a marker are untouched. Packages come from `matchPackageNames`, `matchDepNames` and
`matchPackagePatterns`.

A **condition test** guarding a hold is any tracked file outside `node_modules` whose text contains the
package name and either `renovate.json` or `packageRules` (`git grep -l`); `lift.mjs` deletes it with the rule.

`lift.mjs`: branch `renovate-doctor/lift-<YYYY-MM-DD>` from the default branch, one commit
`chore(deps): lift expired Renovate holds (<packages>)`, push, PR whose body lists `Lifted holds:` one package
per line and carries `<!-- renovate-doctor lift -->`, squash auto-merge enabled. `--today YYYY-MM-DD` and
`--dry-run` (print the diff and the PR body, change nothing on GitHub). Outputs `opened` (`true`/`false`),
`pr_url`, `packages`.

`dashboard-recreate.mjs`: merged PRs carrying the lift marker (last 60 days) give the lifted packages; a
package with no open PR by `renovate[bot]` whose title or branch names it is looked up on the Dependency
Dashboard issue (title `Dependency Dashboard`, author `renovate[bot]`); every unchecked `- [ ]` line that
names the package is ticked and the body is saved once. Idempotent; `--dry-run` prints what it would tick.

## The agent on GitHub

- Every comment the agent or the report posts starts with `<!-- renovate-doctor sha=<head sha> -->` on its own
  line, then a bold `renovate-doctor` heading, the outcome, and two to six sentences.
- A fix commit's message: `fix(deps): <what> so that <PR title> passes (#<pr>)` - conventional, naming the PR.
  Never `--force`; never amend a Renovate commit.
- `merged`: `gh pr merge <n> --auto --squash` after push and comment.
- `rerun`: `gh run rerun <id> --failed`, once.
- `declined`: branch `renovate-doctor/hold-<package>` from the default branch; a rule
  `{ "description": "<blocker>. remove after <date>: <what to check>", "matchPackageNames": [...], "matchUpdateTypes": [...], "enabled": false }`;
  the condition test where the notes file says tests go; PR with `<!-- renovate-doctor hold -->`, auto-merge.
  The Renovate PR is never closed by hand.
- Before claiming `merged`, the agent checks the PR's other checks: a pending visual-snapshot check (Chromatic's
  `UI Tests` and the like) with unaccepted changes means `escalated`, never an approval.
- The agent looks at every failed run on the head SHA, not only the triggering one.
