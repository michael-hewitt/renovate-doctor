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
.github/workflows/ci.yml                this repository's own tests, type check and format check
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
README.md  CHANGELOG.md  LICENSE (MIT)  package.json  pnpm-lock.yaml  tsconfig.json  .nvmrc  .prettierrc  .gitignore
```

Runtime: Node 24 (`.nvmrc`), ES modules, **zero runtime dependencies** (vitest, prettier and typescript are dev only);
the scripts run on the caller's runner straight from a checkout of this repository, so nothing is installed
there. The `gh` CLI is on PATH (GitHub-hosted runners have it; self-hosted ones install it). All GitHub reads
and writes go through `lib/github.mjs`, whose default adapter shells out to `gh api` and which tests replace
with a fake. All outside calls retry a few times with a growing pause: a self-hosted runner's network can
stall for seconds.

Style: prettier with single quotes and `printWidth: 120`; `pnpm run format:check` is part of CI. The
JavaScript is type-checked from its JSDoc (`pnpm run typecheck`: `tsc --checkJs`, strict, also in CI); the
shapes that cross files are `@typedef`s next to the code that owns them. Comments
explain why, in full sentences; file headers say what the script is for and which environment it reads.

## The reusable workflow

`on: workflow_call`. The caller's event payload is `github.event` inside the called workflow, so the gate reads
`$GITHUB_EVENT_PATH` directly. The workflow checks out **this repository at `${{ job.workflow_sha }}`** (the
commit of the reusable workflow file, i.e. the tag the caller pinned) into `.renovate-doctor` inside the
caller's checkout and adds that path to the caller checkout's `.git/info/exclude`, so the agent's `git status`
stays clean. Three jobs: `triage` and `lift` (one of them runs, by `mode`) on the caller's runner, then
`report` on a GitHub-hosted runner, which alone holds the mail key.

Callers adopt it in two steps, because `workflow_dispatch` only runs a workflow file that is on the default
branch and claude-code-action refuses a `push` event: first a caller with only `workflow_dispatch` and
`schedule` (inert until dispatched), merged and rehearsed with a dispatched dry run; then a second PR adds the
`workflow_run` trigger.

### Inputs

| input               | type    | default            | meaning                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | string  | `triage`           | `triage` or `lift`. The caller computes it from its event (`schedule` → `lift`).                                                                                                                                                                                                                                                                                                       |
| `runs_on`           | string  | `"ubuntu-latest"`  | JSON for `runs-on` (a string or an array), used as `runs-on: ${{ fromJSON(inputs.runs_on) }}`.                                                                                                                                                                                                                                                                                         |
| `package_manager`   | string  | `npm`              | `npm` or `pnpm`. With `pnpm` the workflow runs `pnpm/action-setup` (the version from `packageManager`, `dest: ${{ runner.temp }}/setup-pnpm`).                                                                                                                                                                                                                                         |
| `node_version_file` | string  | `.nvmrc`           | Passed to `actions/setup-node` after the PR head is checked out, for the install and the agent (the scripts use this repository's `.nvmrc`).                                                                                                                                                                                                                                           |
| `install`           | string  | by package manager | `npm ci` or `pnpm install --frozen-lockfile`.                                                                                                                                                                                                                                                                                                                                          |
| `typecheck`         | string  | `''`               | Empty means there is no typecheck step.                                                                                                                                                                                                                                                                                                                                                |
| `test`              | string  | by package manager | `npm test` or `pnpm test`.                                                                                                                                                                                                                                                                                                                                                             |
| `service_setup`     | string  | `''`               | Plain Bash and Docker only: run before the install, in the caller's checkout at its own commit (`GITHUB_SHA`), before the PR head is checked out (an older Renovate branch may predate the setup) and before the project's Node and package manager are set up. May write to `$GITHUB_ENV` (a Postgres container exporting `PGPORT`, say). A reusable workflow cannot vary `services`. |
| `service_teardown`  | string  | `''`               | Run `if: always()` after the agent, on the PR-head checkout, so it must be self-contained (inline commands, no repository files).                                                                                                                                                                                                                                                      |
| `email_to`          | string  | required           | Where the report goes.                                                                                                                                                                                                                                                                                                                                                                 |
| `email_from`        | string  | required           | The sender address (must be a sender Mandrill accepts for the key).                                                                                                                                                                                                                                                                                                                    |
| `email_from_name`   | string  | `renovate-doctor`  | The sender's display name.                                                                                                                                                                                                                                                                                                                                                             |
| `notes_file`        | string  | `''`               | Repository-relative path of the project-notes file. Copied from the caller's own commit, before the PR head is checked out, to `$RUNNER_TEMP/renovate-doctor/notes.md`; the agent gets that absolute path, or `none` (with a `::warning::` when the named file does not exist).                                                                                                        |
| `rerun_workflow`    | string  | `''`               | Name of a rerun automation to defer to. When set, a first-attempt failure whose log matches the network signature is left alone.                                                                                                                                                                                                                                                       |
| `renovate_config`   | string  | `renovate.json`    | Path of the Renovate config (JSON); passed as `RENOVATE_CONFIG` to `lift.mjs` and `dashboard-recreate.mjs`.                                                                                                                                                                                                                                                                            |
| `pr`                | number  | `0`                | Manual runs: the PR to triage. A caller forwards its `workflow_dispatch` input as `fromJSON(inputs.pr \|\| '0')`: a dispatch's `number` input is a string in the `inputs` context, and a `type: number` input rejects a string at run creation ("workflow file issue", no jobs).                                                                                                       |
| `run_id`            | number  | `0`                | Manual runs: the failed run to triage; `0` means the latest failed runs on the PR's head. Forwarded as `fromJSON(inputs.run_id \|\| '0')`, as `pr`.                                                                                                                                                                                                                                    |
| `dry_run`           | boolean | `false`            | Nothing is pushed, commented, merged, rerun or opened, as far as a dry run is enforced (see "Dry runs" under the triage job); the gate enforces conditions 1 and 2 and only reports 3-6; the report is printed, not sent.                                                                                                                                                              |
| `timeout_minutes`   | number  | `60`               | The agent job's timeout.                                                                                                                                                                                                                                                                                                                                                               |
| `model`             | string  | `claude-opus-5-5`  | The Claude model the triage and lift agents run on, passed to claude-code-action as `--model`. Without it the action picks its own default (Sonnet in the first caller's dry run).                                                                                                                                                                                                     |

Secrets, declared on `workflow_call` and named explicitly by callers (`secrets: inherit` is only documented
for callers in the same organisation, and this repository is not in the caller's): `CLAUDE_CODE_OAUTH_TOKEN`
(required), `MANDRILL_API_KEY` (required). Only the report job sees `MANDRILL_API_KEY`.

Permissions the caller grants: `contents: write`, `pull-requests: write`, `issues: write`, `actions: write`
(to rerun jobs, and to read runs), `checks: read` and `statuses: read` (the PR's checks), `id-token: write`
(claude-code-action). The Claude App token the agent gets from claude-code-action cannot read Actions runs or
checks (403 "Resource not accessible by integration", seen in the first caller's dry run), so the skill
reads them with `RENOVATE_DOCTOR_ACTIONS_TOKEN`, the job's token, and writes with the App token. Concurrency is the caller's: one group per Renovate
branch, **queued, not cancelled** - a run that arrives after Renovate rebased is dropped by the gate (head
moved) rather than by cancelling an agent mid-work, and GitHub keeps at most one pending run per group.

### Triage job

1. Empty `$RUNNER_TEMP/renovate-doctor` (a non-ephemeral self-hosted runner may keep a stale outcome file).
2. Check out the caller at the run's own commit (`GITHUB_SHA`, `fetch-depth: 0`): the PR head is only known
   after the gate. Then this repository at `${{ job.workflow_sha }}` (from `job.workflow_repository`),
   excluded from git.
3. `actions/setup-node` with **this repository's** `.nvmrc`, for the gate.
4. Work out the install and test commands (inputs cannot default on another input).
5. **Gate**: `node .renovate-doctor/scripts/gate.mjs` (step id `gate`). Always exits 0; its decision is in
   `$GITHUB_OUTPUT`.
6. If `launch == 'true'`, still on the caller's commit: copy `notes_file` (if set and present) to
   `$RUNNER_TEMP/renovate-doctor/notes.md`, and run `service_setup`. Both come from the caller's commit
   because an older Renovate branch may predate them.
7. Then fetch and check out `head_sha` detached (falling back to `refs/pull/<n>/head`); `actions/setup-node`
   with `node_version_file` read at the head; `pnpm/action-setup` with a per-job `dest` when `package_manager`
   is `pnpm`; then `install`, with `continue-on-error: true`, because a failing install is often the failure
   to triage. The prompt tells the agent how it ended.
8. The agent: `anthropics/claude-code-action@v1` with `claude_code_oauth_token`,
   `allowed_bots: renovate[bot],claude[bot],github-actions[bot]` (the action refuses bot actors otherwise,
   and a triage run's actor is always one of these),
   `claude_args: --allowedTools "Bash,Edit,Write,Read,Glob,Grep"`, and the prompt below. Step id `agent`;
   `continue-on-error: true` is **not** used. Its env carries `RENOVATE_DOCTOR_ACTIONS_TOKEN` (the job's
   token, for `gh run rerun` only: the Claude App token may not rerun jobs; empty in a dry run) and longer Bash
   timeouts. A dry run gets the Claude App token like a real run, so the token exchange is rehearsed too.
   The gate step gets `RENOVATE_DOCTOR_COMMENT_AUTHORS` from the caller's
   repository or organisation variable of that name (`vars`), empty meaning the gate's default.
9. **Dry runs** are enforced by four things together: the gate (conditions 1 and 2 hold even in a dry run),
   the prompt and the skill, a deny list, and the withheld `RENOVATE_DOCTOR_ACTIONS_TOKEN`. `claude_args`
   adds `--disallowedTools` with the job-level `RENOVATE_DOCTOR_DRY_RUN_REFUSED` list: `Bash(git push:*)`,
   `Bash(gh api:*)`, `Bash(gh pr merge:*)`, `Bash(gh pr create:*)`, `Bash(gh pr comment:*)`,
   `Bash(gh pr edit:*)`, `Bash(gh pr close:*)`, `Bash(gh pr review:*)`, `Bash(gh run rerun:*)`,
   `Bash(gh issue:*)`, `Bash(gh pr ready:*)`, `Bash(gh pr reopen:*)`, `Bash(gh workflow run:*)`,
   `Bash(gh label:*)`, `Bash(gh run cancel:*)`, `Bash(gh release:*)`. Deny rules win over the allow list,
   apply to every subcommand of a compound command, and match past a leading variable assignment (so
   `GH_TOKEN=... gh run rerun` is refused). The deny list is **best effort**: Claude Code's permission rules
   match command text, so `bash -c`, `curl` or a script can get past them, and the App token the agent holds
   can write. The prompt lists the refused commands and says a refusal is expected.
10. Upload the transcript (`steps.agent.outputs.execution_file`) as artifact
    `renovate-doctor-transcript-<run_id>-<run_attempt>`, 30 days, `continue-on-error: true`, `overwrite: true`.
11. Upload the outcome file as artifact `renovate-doctor-outcome-<run_id>-<run_attempt>`,
    `if: always() && launch == 'true'`, `if-no-files-found: ignore`; per attempt, so a re-run never reports an
    earlier attempt's outcome.
12. `service_teardown`, `if: always() && launch == 'true' && inputs.service_teardown != ''`, on the PR-head
    checkout.
13. When the agent did not run, the gate's reason is printed and written to the job summary.

Job outputs for the report job: `launch`, `outcome`, `summary`, `reason`, `pr_number`, `pr_url`, `pr_title`,
`head_sha` (the gate's), `agent_outcome` (`steps.agent.outcome`) and `attempt` (`github.run_attempt`, which
names the outcome artifact; a re-run of the report job alone is a later attempt and must still find it).

The prompt (from the workflow, not the skill) says: read `.renovate-doctor/skills/renovate-doctor/SKILL.md`
first and follow it exactly; then read the notes file if given; the repository; the PR number, URL and title;
the head SHA and branch; the failed run ids and where their logs are
(`$RUNNER_TEMP/renovate-doctor/logs/<run_id>.log`, written by the gate); the install command and how the
workflow's install ended, the typecheck and test commands; the number of fix attempts already on the branch;
`rerun_before`; whether this is a dry run; the outcome file path; the notes file (an absolute path, or
`none`); the rerun-workflow name if any; the gate's reason (and verdict, in a dry run); and either the
refused commands (dry run) or that reruns use `RENOVATE_DOCTOR_ACTIONS_TOKEN`.

### Lift job

1. Check out the caller's default branch (`fetch-depth: 0`: the next step reads the config's history) and
   this repository; setup node with this repository's `.nvmrc` (only its scripts run here). Permissions:
   `contents`, `pull-requests`, `issues` write and `id-token: write`.
2. `node .renovate-doctor/scripts/dashboard-recreate.mjs` with the job's token (`continue-on-error`): for every
   hold lifted from the config in the last 60 days for which Renovate has opened no PR since, tick the
   Dependency Dashboard "recreate" checkbox naming it.
3. `node .renovate-doctor/scripts/lift.mjs`, run **inside** `anthropics/claude-code-action@v1`. The action
   exports the Claude App token, whose pushes start CI; a `GITHUB_TOKEN` push never does, so the lift PR's
   auto-merge would wait forever. The agent may run exactly that one command
   (`--allowedTools "Bash(<command>)" --max-turns 3`). The script's `$GITHUB_OUTPUT` inside the action is the
   action's inner step's, so it also writes its outputs and `exit_code` to `$RUNNER_TEMP/renovate-doctor/lift.json`.
4. A step reads `lift.json` into `LIFT_OUTCOME`: `failure` when the file is missing, `exit_code` is not 0 or the
   agent step failed; `blocked` when `blocked=true`; `opened` when `opened=true` (or, in a dry run, when
   `removed` is above 0, so the rehearsal prints the email; `packages` can be empty for a rule matched by
   prefix); otherwise `nothing`.
5. Job outputs `outcome`, `pr_url` and `summary` (from step 4) for the report job, which emails (through
   `report.mjs` in lift mode) when a PR was opened, the lift was blocked by an open earlier lift PR, or the
   step failed, and is silent when nothing had expired.

### Report job

`needs: [triage, lift]`, `if: always() && (needs.triage.result != 'skipped' || needs.lift.result != 'skipped')`,
`runs-on: ubuntu-latest` always (a GitHub-hosted runner, so the mail key never lands on the caller's runner;
an input only when a caller needs one), permissions `issues: write` and `pull-requests: write` (the
gate-escalation comment) and nothing else. It checks out this repository at `${{ job.workflow_sha }}`, sets
up its Node, downloads `renovate-doctor-outcome-<run_id>-<needs.triage.outputs.attempt>` into
`$RUNNER_TEMP/renovate-doctor/` (`continue-on-error`: a run whose agent wrote nothing uploads nothing), and
runs `node scripts/report.mjs` with the report contract's environment from the two jobs' outputs (and
`TRIAGE_RESULT: needs.triage.result`): in triage mode when `launch == 'true' || outcome != ''`, or when the
triage job's result is `failure` or `cancelled` and `launch` is empty (it broke before the gate ran: a
checkout, a setup, a misspelt input, a lost runner), in lift mode always (an empty `LIFT_OUTCOME`, from a lift job that died
early, is reported as a failure). `report.mjs` reads no file from the caller's repository, only the outcome
file.

### What the agent and the install can read

Code run in the triage job after the gate - the project's install, with the updated dependency's install
scripts, and every command the agent runs - can read what the job holds: `CLAUDE_CODE_OAUTH_TOKEN`, the
Claude App token the action mints, and the job's own `GITHUB_TOKEN`. That is inherent: the agent needs them
to work, and the install runs on the same runner. It can also append to `$GITHUB_ENV` and rewrite any file
in the workspace, `.renovate-doctor` included, which changes every later step of the job. That is why the
mail key is kept out of the triage and lift jobs entirely and the report runs in a job of its own, from a
fresh checkout, taking only job outputs and the outcome file (validated data) across.

## Gate contract (`scripts/gate.mjs`)

Environment: `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GH_TOKEN`, `RUNNER_TEMP`,
`INPUT_PR`, `INPUT_RUN_ID`, `INPUT_DRY_RUN` (`true`/`false`), `RERUN_WORKFLOW`, `GITHUB_OUTPUT`,
`GITHUB_WORKFLOW_REF` (set by Actions; it names the caller's own renovate-doctor workflow file, whose failed
runs are left out of `failed_run_ids`), `RENOVATE_DOCTOR_COMMENT_AUTHORS` (comma-separated logins whose
markers count for condition 4; default `claude[bot],github-actions[bot]`, the agent's App token and the
report's job token).

Decision, in order; the first failing condition is the reason:

1. **failure**: the triggering run concluded `failure` (`workflow_run`); for a manual run, the chosen run (or
   at least one run on the head) concluded `failure`. A manual run is a `workflow_dispatch`, or any other
   event with `INPUT_PR` set (harmless, though claude-code-action itself refuses `push`, so in practice a
   manual run is dispatched); any other event without a PR is a gate error.
2. **renovate**: the run comes from this repository (`head_repository.full_name` equals `GITHUB_REPOSITORY`;
   otherwise `renovate: run <id> came from fork <name>`, since a fork can push Renovate's exact commit to a
   same-named branch), the head branch starts with `renovate/`, and the PR's author is `renovate[bot]`.
   For a manual run with `run_id`, the run's `head_branch` must be the PR's `head.ref` (otherwise
   `renovate: run <id> is on <branch>, not the PR's <ref>`), so a Renovate PR's number cannot carry the agent
   onto another branch's failed run; like the rest of this condition, it holds in a dry run too. Fork runs on
   the head SHA are also left out of `failed_run_ids`.
3. **open**: exactly one open PR has that head branch, and its head SHA equals the run's head SHA (for a manual
   run with `run_id`, the run's head may be older than the PR's; this is reported and, outside dry run, skips).
4. **not handled**: no PR comment carries a marker `<!-- renovate-doctor sha=<head sha> outcome=<outcome> -->`
   whose outcome is anything but `rerun` (a marker without `outcome=` counts as handled). A `rerun` comment
   does not settle the SHA: the rerun failed again, so the doctor looks a second time, and `rerun_before`
   tells the agent its rerun already happened. Only comments by a login in `RENOVATE_DOCTOR_COMMENT_AUTHORS`
   count: a marker is invisible when rendered and anyone may comment, so a marker from anyone else is
   ignored, with a `::warning::` line naming its author (so a wrong login in the list shows on the run
   rather than as a silent second triage).
5. **not the rerun automation's turn**: when `RERUN_WORKFLOW` is set and the run's `run_attempt` is 1 and the
   failed log matches the network signature, skip (the rerun automation acts first; this runs on attempt 2).
   The log fetch waits for GitHub to publish it, up to about four minutes, as a project's rerun workflow would.
6. **attempts left**: fewer than two commits on the PR are by anyone other than `renovate[bot]`. Two or more
   means `launch=false`, `outcome=escalated`, `summary=fix attempts exhausted ...` - the report job emails
   and comments on the gate's behalf.

A **gate error** (any exception) never launches: `launch=false`, `reason=gate error: <message>`,
`outcome=failed`, and `summary` carrying the reason and the first stack frame, so the report job emails it
rather than leaving a real failure untriaged behind a green run. The stack goes to stderr; the script still
exits 0.

In **dry run** conditions 1 (failure) and 2 (renovate, the fork check included) are **enforced**: a dry run
never launches on a run that did not fail or on a PR that is not Renovate's, since the agent works on
whatever it is launched on; such a skip reads `dry run: would skip: <condition>: ... (failure and renovate
hold even in a dry run)`. Conditions 3-6 are only reported: every one is evaluated and printed, `verdict`
carries the would-be decision, and `launch` is `true` whenever the PR and run could be resolved at all, so a
rehearsal can target a closed PR, an old failed run or a settled head.

Outputs (`$GITHUB_OUTPUT`): `launch` (`true`/`false`), `reason` (one line), `verdict` (dry run only),
`outcome` (`escalated`, `failed` for a gate error, or empty), `summary` (for an outcome the gate produced), `pr_number`, `pr_url`,
`pr_title`, `head_sha`, `head_branch`, `failed_run_ids` (comma-separated: every failed run on the head SHA,
the doctor's own workflow and fork runs excluded, the triggering run first), `attempts` (fix attempts already on the
branch), `rerun_before` (`true`/`false`: a renovate-doctor comment with `outcome=rerun` exists for the head
SHA). The gate also writes each failed run's failed-job logs (last 600 lines per job) to
`$RUNNER_TEMP/renovate-doctor/logs/<run_id>.log` for the agent.

## Outcome file (`$RUNNER_TEMP/renovate-doctor/outcome.json`)

Written by the agent, carried to the report job as the artifact `renovate-doctor-outcome-<run_id>`, and read
there. `lib/outcome.mjs` validates it.

```json
{
  "outcome": "merged | rerun | declined | escalated | skipped",
  "classification": "unrelated | fixable | not-takeable | needs-human",
  "summary": "One paragraph, plain text, written for the email: what failed, why, what was done.",
  "mention": false,
  "links": { "config_pr": "https://github.com/owner/repo/pull/123" }
}
```

`mention: true` on `merged` or `rerun` asks for an email anyway. `skipped` means the PR closed or Renovate
pushed a new head before the agent acted (or before its push landed): no comment, no classification, no
email. `links` holds only what exists; the PR and run links come from the workflow, not the agent. `merged`
means auto-merge is enabled and the agent's fix passed typecheck and tests locally; the merge itself waits
for CI.

## Report contract (`scripts/report.mjs`)

Environment: `REPORT_MODE` (`triage`/`lift`), `OUTCOME_FILE`, `AGENT_OUTCOME` (the agent step's `outcome`:
`success`/`failure`/`cancelled`/`skipped`), `TRIAGE_RESULT` (the triage job's result), `GATE_OUTCOME`, `GATE_SUMMARY`, `GATE_REASON`, `DRY_RUN`,
`PR_NUMBER`, `PR_URL`, `PR_TITLE`, `HEAD_SHA`, `RUN_URL`, `GITHUB_REPOSITORY`, `GH_TOKEN`, `EMAIL_TO`,
`EMAIL_FROM`, `EMAIL_FROM_NAME`, `MANDRILL_API_KEY`; for lift: `LIFT_OUTCOME` (`opened`/`nothing`/`blocked`/`failure`),
`LIFT_PR_URL`, `LIFT_SUMMARY`.

Rules: no email for `merged` or `rerun` without `mention`, and never for `skipped`; otherwise one plain-text
email. No outcome file and an agent step that failed or was cancelled → outcome `failed` ("the run failed",
with the run link); no outcome file and a successful agent step → `escalated` ("the agent wrote no
outcome"). No gate output at all (no `GATE_REASON`, no `GATE_OUTCOME`), no agent run and a `TRIAGE_RESULT` of
`failure` or `cancelled` → `failed`, "the triage job failed (was cancelled) before the gate ran", with the run
link and the subject `[renovate-doctor] failed: <PR title, or "triage job">`. When the gate produced the outcome no agent ran: for `escalated` (attempts exhausted) the report
also posts the PR comment, with the sha marker; for `failed` (a gate error) it only emails, since that says
nothing about the PR and its marker would count as handled. Subject: `[renovate-doctor] <outcome>: <PR title>`; body: the
summary, then `PR:`, `Run:` and, when present, `Config PR:` links, then one line naming the repository. Dry
run prints `Subject:` and the body to stdout and sends nothing. A refused send fails the step (the email is
the product of a non-merged run).

## Lift contract (`scripts/lift.mjs`, `lib/renovate_config.mjs`)

A dated hold is a package rule with `"enabled": false` whose `description` contains `remove after YYYY-MM-DD:`
(the same marker form as a removal-marker TODO, so both read the same). `removeExpiredRules(text, today)`
returns `{ text, removed: [{ packages, date, description, index }], malformed: [...] }`; the returned text
keeps the file's formatting (removed rules are spliced out of the text; with `packageRules` written twice, the
last one, which `JSON.parse` reads, is edited); a rule whose date is not a valid ISO date is reported as malformed and left alone;
rules without a marker are untouched. Packages come from `matchPackageNames`, `matchDepNames` and
`matchPackagePatterns`; a rule naming none (matched by prefix or source URL, say) is named
`rule <index>: <start of its description>` in the title, summary and PR body.

A **condition test** guarding a hold is a tracked file outside `node_modules` whose path looks like a test (a
`test`, `tests`, `__tests__` or `spec` directory, or `.test.`/`.spec.` in the name, any case) and which carries
the marker `renovate-doctor hold: <package>` in a comment, ending its line (bar a `*/` or `-->` closer, so the
marker for `vite` is not found in the one for `vite-plugin-pwa`; `git grep -l -E`). Nothing else counts: a
test naming the package (as the other side of a peer check, say) without the marker is never deleted.
`lift.mjs` deletes every marked test with the rule; Renovate config files and `package.json` never count.

`lift.mjs`: branch `renovate-doctor/lift-<YYYY-MM-DD>` from the default branch, one commit
`chore(deps): lift expired Renovate holds (<packages>)`, push, PR whose body lists `Lifted holds:` one package
per line and carries `<!-- renovate-doctor lift -->`, squash auto-merge enabled when the default branch
requires checks. `--today YYYY-MM-DD` and `--dry-run` (print the diff and the PR body, change nothing on
GitHub). Outputs (`$GITHUB_OUTPUT`, and with `exit_code` to `$RUNNER_TEMP/renovate-doctor/lift.json` when
`RUNNER_TEMP` is set) `opened` (`true`/`false`), `blocked` (`true`/`false`), `pr_url`, `packages`, `removed`
(the number of holds, i.e. rules, removed or, in a dry run, to be removed), and `summary` (one line for the email subject, e.g. `lifted 2 expired holds: foo, bar`, counting holds, not
packages; `lift failed: <why>` when the step fails).

Only PRs whose head is a branch of this repository (`head.repo.full_name` is the repository) are reused or
block; a fork's PR is ignored, since the lift's branch name is predictable.

- **Reuse.** When today's branch already has an open PR (a rerun of the same day's job, or a create whose
  answer was lost), that PR is reused: nothing is pushed again and its URL is the output. When today's branch
  is on the remote with no open PR (an earlier run today failed before opening one), the remote branch is
  deleted and pushed fresh.
- **Blocked.** When an open PR on another `renovate-doctor/lift-*` branch carries the lift marker, nothing is
  lifted: `opened=false`,
  `blocked=true`, `pr_url` is that PR and `summary` is `previous lift PR still open: <url>`; the report emails
  `[renovate-doctor] lift blocked`.
- **Required checks.** Auto-merge is enabled only when the default branch requires status checks: branch
  protection's `required_status_checks` (non-empty `contexts` or `checks`), or, when that is 404 or empty, a
  `required_status_checks` rule from `rules/branches/<default>`. When neither requires any, auto-merge
  would merge before CI ran, so it is left off and the PR body and `summary` say so. When GitHub refuses to
  say (403, or any other error), auto-merge is enabled and the `summary` notes that the protection could not
  be read.

`dashboard-recreate.mjs`: the lifted packages come from the config's git history, which covers both ways a
hold is lifted (a lift PR, and the agent's fix commit on a Renovate PR a condition test fired on): for every
commit on the default branch in the last 60 days that touched the config (`RENOVATE_CONFIG`, default
`renovate.json`; `git log --first-parent --since`), a package named by an `enabled: false` rule before the
commit and by none after it was lifted, unless the current config holds it again; a commit whose config
before or after is not valid JSON is skipped. The `Lifted holds:` lines in a lift PR body are for people,
not a source. A lifted package is left alone when a PR by `renovate[bot]` whose title or branch names it was
created or closed at or after the lifting commit's date, or is open now (Renovate reopens an autoclosed PR,
which keeps its old `created_at`); PRs are read with `pulls?state=all&sort=updated&direction=desc` back to
the oldest lift. Renovate has acted on the lift, and a PR a person closed since must stay closed.
Otherwise it is looked up on the Dependency Dashboard issue (title `Dependency Dashboard`, author
`renovate[bot]`); every unchecked `- [ ]` **recreate** line (`<!-- recreate-branch=... -->`, Renovate's form
for an update blocked by a closed PR) that names the package is ticked, never a rebase, approve or unlimit
line, and the body is saved once. Idempotent; `--dry-run` prints what it would tick.

## The agent on GitHub

- Every comment the agent or the report posts starts with `<!-- renovate-doctor sha=<head sha> outcome=<outcome> -->`
  on its own line, then a bold `renovate-doctor` heading, the outcome, and two to six sentences.
- A fix commit's message: `fix(deps): <what> so that <PR title> passes (#<pr>)` - conventional, naming the PR.
  Never `--force`; never amend a Renovate commit.
- The agent reads GitHub through `gh` subcommands (`gh pr view`, `gh pr checks`, `gh pr list`, `gh run list`,
  `gh run view`); its only `gh api` calls are the two required-checks GETs, which a dry run blocks.
- `merged`: `gh pr merge <n> --auto --squash` after push, only when the default branch requires checks (the
  same reading as the lift's "Required checks"); with none required, the fix stays pushed without
  auto-merge and the outcome is `escalated`.
- `rerun`: `gh run rerun <id> --failed`, once.
- `declined`: branch `renovate-doctor/hold-<package>` from the default branch; a rule
  `{ "description": "<blocker>. remove after <date>: <what to check>", "matchPackageNames": [...], "matchUpdateTypes": [...], "enabled": false }`;
  the condition test where the notes file says tests go; PR with `<!-- renovate-doctor hold -->`, auto-merge
  when the default branch requires checks. An open hold PR for the package is reused, never doubled; a
  leftover branch with no open PR is deleted and pushed fresh. The Renovate PR is never closed by hand.
- Before claiming `merged`, the agent checks the PR's other checks: a pending visual-snapshot check (Chromatic's
  `UI Tests` and the like) with unaccepted changes means `escalated`, never an approval.
- The agent looks at every failed run on the head SHA, not only the triggering one.
