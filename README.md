# renovate-doctor

When a Renovate PR fails CI, an agent fixes and merges it, reruns it, or declines it with a trip wire.

renovate-doctor is a reusable GitHub Actions workflow. Your repository calls it from a short caller workflow.
When one of your CI workflows fails on a Renovate PR, an agent (Claude Code, through
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)) does what an engineer
would. It reads every failed log and reproduces the failure with your project's own install, typecheck and test
commands. Then it fixes the branch and turns on auto-merge, reruns a failure that has nothing to do with the
update, or declines the update. A decline adds a Renovate rule that disables it, plus a trip wire that brings it
back once it can be taken. A good outcome is silent, with a short comment on the PR for the record. Whenever the
agent did not merge, or has something worth saying, one plain-text email goes to your engineering address. A
monthly lift run takes back the date-based holds whose date has passed, so a declined update is never
forgotten.

- [How it works](#how-it-works): the trigger, the outcomes, the email rule, the trip-wire loop, the gate
- [Adopting it](#adopting-it): prerequisites, a complete caller, inputs, secrets, the notes file
- [Trying it safely](#trying-it-safely): dry runs, and running the skill by hand
- [Guardrails](#guardrails) and [known gaps](#known-gaps)

The agent's whole procedure is [skills/renovate-doctor/SKILL.md](skills/renovate-doctor/SKILL.md), readable by
a person. The contracts between the pieces are in [docs/architecture.md](docs/architecture.md), and the design
is in [issue #1](https://github.com/michael-hewitt/renovate-doctor/issues/1).

## How it works

### The trigger

Your caller workflow runs on `workflow_run` completion of the CI workflows you name (triage mode), on a monthly
`schedule` (lift mode), and on `workflow_dispatch` for manual and dry runs. Every triage run starts with the
**gate**, a script that decides in a few seconds whether the failure gets the agent. Most runs stop there, and
the run's summary page says why.

### The five outcomes

Each triage run on which the agent was launched ends in exactly one outcome:

| outcome     | when                                                                                                                                                     | what happens to the PR                                                                                                                                                     | email                                                  | PR comment |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------- |
| `merged`    | The update needs a small, mechanical fix (a peer range, missing types, a renamed option).                                                                | The agent commits the fix to the Renovate branch, runs typecheck and tests, pushes, and enables squash auto-merge. GitHub merges it once the required checks pass.         | Only when the agent flags it as worth a mention.       | yes        |
| `rerun`     | The failure has nothing to do with the update (a flaky test, a stalled network).                                                                         | The failed jobs are rerun once.                                                                                                                                            | Only when the agent flags it (a recurring flake, say). | yes        |
| `declined`  | The update cannot be taken yet (no compatible upstream release, a breaking change needing real work).                                                    | A separate hold PR, on auto-merge, adds a disabled package rule with a dated marker and, where possible, a condition test. Renovate closes its own PR when the hold lands. | yes, linking the hold PR                               | yes        |
| `escalated` | Anything that needs a person: a visual-snapshot change, a failure not understood after a bounded look, security or billing code, the second fix attempt. | Nothing is changed. The comment says what was found and where to look.                                                                                                     | yes                                                    | yes        |
| `skipped`   | The PR closed, or Renovate pushed a new head, before the agent acted.                                                                                    | Nothing; the run on the new head decides.                                                                                                                                  | never                                                  | none       |

More results come from the workflow rather than the agent. A run that broke (the agent step failed, or wrote
no usable outcome) is reported as `failed` or `escalated`, with an email; so is a gate that crashed, and a
triage job that broke before the gate ran (a typo in the caller's inputs, say), both as `failed`.
When the branch already carries two fix attempts, the gate escalates without launching the agent, and the
report job posts the comment itself.

The agent never closes a Renovate PR. If a person closes it, Renovate ignores that version for good. If
Renovate closes it itself (because a hold landed), Renovate reopens the update once the hold goes away.

### The email rule

One plain-text email per run, or none, from the report job, never from the agent:

- **No email** for `merged` or `rerun` unless the agent set `mention`, and never for `skipped`.
- **One email** for `declined`, `escalated`, and every run that failed. The subject is
  `[renovate-doctor] <outcome>: <PR title>`. The body has the agent's summary and links to the PR, the run and,
  for a decline, the hold PR.
- Lift mode emails when it opened a lift PR, when it lifted nothing because an earlier lift PR is still open
  (`[renovate-doctor] lift blocked`), or when it failed, and is silent when nothing had expired.

The mail goes through Mandrill's send API, from a separate `report` job on a GitHub-hosted runner that runs
only renovate-doctor's own scripts (see [Secrets](#secrets)). A refused send fails the report job, because the
email is the whole product of a run that did not merge.

### The trip-wire loop

Every declined update carries a trip wire that brings it back:

1. **Condition test** (preferred, when the blocker can be read from an installed package): a test in your own
   test runner reads the blocking fact (a peer range, `engines`, an exported symbol) and fails the moment it
   changes. Typically a newer release of the _other_ package lifts the blocker. That release arrives as its own
   Renovate PR, and the test fails on it. Triage runs, and the agent reads the test's message, removes the hold
   rule and deletes the test in its fix commit. Renovate then reopens the held update. If it has opened no PR
   for it by the next monthly lift run, the lift ticks the update's "recreate" line on the Dependency
   Dashboard. The test carries one comment line per package whose hold it guards, ending the line, for
   example `// renovate-doctor hold: @vite-pwa/assets-generator`; that line, in a file whose path looks like
   a test, is how the lift finds the test to delete with an expired dated hold, and a test without it is
   never deleted.
2. **Dated marker** (always present, alone when nothing can be tested): the rule's description contains
   `remove after YYYY-MM-DD: <what to check>`. The monthly lift run removes every rule whose date has passed,
   together with any condition test carrying its marker line, in one PR on auto-merge (left for you to merge
   when the default branch requires no checks). Renovate then retries the update, and if it still cannot be
   taken, it fails CI and is triaged like any other. The next lift run ticks "recreate" on the Dependency
   Dashboard for lifted holds Renovate has not acted on since (no PR of its for the package opened, reopened
   or closed); a PR Renovate opened and a person then closed stays closed.

A hold rule looks like this:

```json
{
  "description": "vite-plugin-pwa 1.x accepts @vite-pwa/assets-generator only as ^1.0.0. remove after 2027-01-12: check whether vite-plugin-pwa@latest accepts v2",
  "matchPackageNames": ["@vite-pwa/assets-generator"],
  "matchUpdateTypes": ["major"],
  "enabled": false
}
```

And a condition test guarding it (vitest here; any runner works) looks like this:

```ts
// renovate-doctor hold: @vite-pwa/assets-generator
// vite-plugin-pwa 1.x accepts the generator only as ^1.0.0 (Renovate PR #3886, hold PR #3890).
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const generator = '@vite-pwa/assets-generator';
const config = JSON.parse(readFileSync('renovate.json', 'utf8'));
const hold = config.packageRules?.find((rule) => rule.enabled === false && rule.matchPackageNames?.includes(generator));
const plugin = JSON.parse(readFileSync('node_modules/vite-plugin-pwa/package.json', 'utf8'));

test.skipIf(!hold)('vite-plugin-pwa still accepts the generator only at v1', () => {
  expect(
    plugin.peerDependencies?.[generator],
    `vite-plugin-pwa ${plugin.version} now accepts another generator range. If it accepts v2, remove the hold ` +
      `rule for ${generator} from renovate.json and delete this test in the same commit.`,
  ).toMatch(/^\^1\.\d+\.\d+$/);
});
```

### The gate

The agent is launched only when all of these hold, checked in order; the first that fails is the reason the
run stops:

1. **failure**: the triggering run concluded `failure` (for a manual run, the chosen run or one on the PR's
   head).
2. **renovate**: the run comes from this repository, not a fork pushing to a same-named branch; the head branch
   starts with `renovate/`; and the PR's author is `renovate[bot]`.
3. **open**: exactly one open PR has that branch, and its head SHA is the failed run's.
4. **not handled**: no renovate-doctor comment on the PR has already settled that head SHA. A `rerun` comment
   does not settle it: if the rerun fails again, the agent looks a second time, knowing its rerun is spent.
   Only comments by the doctor's own accounts count, because the marker is invisible and anyone may comment;
   see [Comment authors](#comment-authors).
5. **not the rerun automation's turn**: when you name a rerun automation (`rerun_workflow`), a first-attempt
   failure whose log matches the network signature is left to it.
6. **attempts left**: fewer than two commits on the branch are by anyone other than `renovate[bot]`. With two,
   the gate escalates without launching the agent.

## Adopting it

### Prerequisites

- **The Claude GitHub App** installed on the repository (<https://github.com/apps/claude>). The agent pushes,
  comments and merges with the App's token, and pushes made with that token start your CI. Pushes made with
  the workflow's own `GITHUB_TOKEN` never start workflows, so a fix or lift PR pushed that way would wait
  forever for its checks.
- **Branch protection requiring your CI checks** on the default branch, and **Allow auto-merge** turned on in the
  repository settings. Without required checks, `gh pr merge --auto` merges at once, before CI has run on the
  fix; the lift checks for them and, finding none, leaves its PR for you to merge.
- **A Renovate config in JSON** (`renovate.json` by default, or set `renovate_config`) with the Dependency
  Dashboard enabled, which Renovate's default config does.
- **The caller workflow on the default branch.** GitHub only fires `workflow_run` from the copy of the workflow
  file on the default branch.
- **On a self-hosted runner**: `git`, `gh` and `bash` on PATH (Node is installed by `actions/setup-node`), and
  Docker if your `service_setup` starts a container.
- **GitHub-hosted runners available to the repository**, even if everything else runs on your own: the report
  job always runs on `ubuntu-latest`, so the mail key never lands on your runner. It takes a few seconds per
  run (Actions minutes, on a private repository).

### A complete caller

Save as `.github/workflows/renovate-doctor.yml` in your repository. This is the final state; adopt it in two
steps, merging it first without the `workflow_run` block and rehearsing with a dry run before adding it (see
[Dry runs](#dry-runs)).

```yaml
name: renovate-doctor

on:
  # Triage: a CI workflow finished on a Renovate branch. Name every workflow whose failure should be triaged.
  workflow_run:
    workflows: ['CI']
    types: [completed]
    branches: ['renovate/**']
  # Lift: once a month, remove the holds whose date has passed.
  schedule:
    - cron: '0 12 1 * *'
  # Manual and dry runs.
  workflow_dispatch:
    inputs:
      mode:
        description: 'triage (a PR) or lift (expired holds)'
        type: choice
        options: [triage, lift]
        default: triage
      pr:
        description: 'PR number to triage'
        type: number
        default: 0
      run_id:
        description: 'Failed run to triage (0 = the failed runs on the PR head)'
        type: number
        default: 0
      dry_run:
        description: 'Change nothing; print the email instead of sending it'
        type: boolean
        default: true

jobs:
  renovate-doctor:
    # Only failures are worth a runner; the gate checks everything else.
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'failure'
    # One run per Renovate branch at a time, queued rather than cancelled, so an agent is never stopped
    # mid-push. A run that arrives after Renovate rebased is dropped by the gate (the head moved).
    concurrency:
      group: renovate-doctor-${{ github.event.workflow_run.head_branch || inputs.pr || 'lift' }}
      cancel-in-progress: false
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: write # to rerun failed jobs, and to read runs: the Claude App token cannot
      checks: read # the PR's checks, read with the job's token for the same reason
      statuses: read
      id-token: write # claude-code-action exchanges it for the Claude GitHub App token
    uses: michael-hewitt/renovate-doctor/.github/workflows/renovate-doctor.yml@v0.1.0
    with:
      mode: ${{ (github.event_name == 'schedule' || inputs.mode == 'lift') && 'lift' || 'triage' }}
      runs_on: '"ubuntu-latest"'
      package_manager: pnpm
      typecheck: pnpm run typecheck
      email_to: engineering@example.com
      email_from: renovate-doctor@example.com
      notes_file: .github/renovate-doctor.md
      # `fromJSON`, not the bare input: a workflow_dispatch `number` input is a string in the `inputs` context,
      # and the reusable workflow's `type: number` rejects a string before any job exists.
      pr: ${{ fromJSON(inputs.pr || '0') }}
      run_id: ${{ fromJSON(inputs.run_id || '0') }}
      dry_run: ${{ inputs.dry_run == true }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      MANDRILL_API_KEY: ${{ secrets.MANDRILL_API_KEY }}
```

The secrets are named explicitly rather than passed with `secrets: inherit`. GitHub documents `inherit` only
for callers in the same organisation or enterprise as the reusable workflow, and this repository is not in
yours. Naming them also makes it plain that the workflow receives exactly two secrets.

Pin a tag (`@v0.1.0`), never `@main`: the workflow checks out its scripts and skill at the commit of the tag
you pinned, so what runs is what you chose. Renovate can update the pin like any other dependency.

If your tests need a service, start it in `service_setup`, because a reusable workflow cannot take a
`services:` block from its caller. `service_setup` runs on your repository at the commit the run started from
(your default branch), before the PR head is checked out, because an older Renovate branch may predate it,
and before your project's Node and package manager are set up: plain Bash and Docker only.
`service_teardown` runs after the agent, on the PR-head checkout, so it must be self-contained: inline
commands, nothing read from the repository. For example, Postgres on a free port:

```yaml
service_setup: |
  RENOVATE_DOCTOR_PG="renovate-doctor-pg-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  echo "RENOVATE_DOCTOR_PG=$RENOVATE_DOCTOR_PG" >> "$GITHUB_ENV"
  docker run -d --name "$RENOVATE_DOCTOR_PG" -e POSTGRES_PASSWORD=postgres -p 127.0.0.1::5432 postgres:17
  # Over TCP: the image's first start runs a temporary socket-only server, which a socket check would accept.
  until docker exec "$RENOVATE_DOCTOR_PG" pg_isready -h 127.0.0.1 -U postgres; do sleep 2; done
  echo "PGPORT=$(docker port "$RENOVATE_DOCTOR_PG" 5432/tcp | head -1 | cut -d: -f2)" >> "$GITHUB_ENV"
service_teardown: docker rm -f "$RENOVATE_DOCTOR_PG"
```

### Inputs

| input               | type    | default            | meaning                                                                                                                                                                            |
| ------------------- | ------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`              | string  | `triage`           | `triage` or `lift`. Compute it from the event, as the caller above does.                                                                                                           |
| `runs_on`           | string  | `"ubuntu-latest"`  | JSON for `runs-on`: a quoted string or an array such as `'["self-hosted", "linux"]'`.                                                                                              |
| `package_manager`   | string  | `npm`              | `npm` or `pnpm`. With `pnpm`, the version named by `packageManager` in `package.json` is installed.                                                                                |
| `node_version_file` | string  | `.nvmrc`           | Your project's Node version file, read at the PR head, so a PR that moves Node is reproduced on the new version.                                                                   |
| `install`           | string  | by package manager | `npm ci` or `pnpm install --frozen-lockfile`. The workflow runs it before the agent; a failed install is handed to the agent to triage, not treated as an error.                   |
| `typecheck`         | string  | `''`               | Empty means the project has no typecheck.                                                                                                                                          |
| `test`              | string  | by package manager | `npm test` or `pnpm test`.                                                                                                                                                         |
| `service_setup`     | string  | `''`               | Plain Bash and Docker only (your toolchain is not installed yet), run before the install on your commit (not the PR head); may write to `$GITHUB_ENV` (a database port, say).      |
| `service_teardown`  | string  | `''`               | Bash run after the agent, whatever happened, on the PR-head checkout: keep it self-contained.                                                                                      |
| `email_to`          | string  | required           | Where the report goes.                                                                                                                                                             |
| `email_from`        | string  | required           | The sender address; Mandrill must accept it for your key (a verified sending domain).                                                                                              |
| `email_from_name`   | string  | `renovate-doctor`  | The sender's display name.                                                                                                                                                         |
| `notes_file`        | string  | `''`               | Repository-relative path of your project-notes file, read from your commit (not the PR head). A path that does not exist gives a warning and no notes.                             |
| `rerun_workflow`    | string  | `''`               | Name of your own rerun automation, if you have one. A first-attempt network failure is then left to it, and the doctor looks only if the rerun fails too.                          |
| `renovate_config`   | string  | `renovate.json`    | Repository-relative path of the Renovate config. The lift mode edits it and reads its history; it must be JSON.                                                                    |
| `pr`                | number  | `0`                | Manual runs: the PR to triage.                                                                                                                                                     |
| `run_id`            | number  | `0`                | Manual runs: the failed run to triage; `0` means the failed runs on the PR's head.                                                                                                 |
| `dry_run`           | boolean | `false`            | Push, comment, merge, rerun and open nothing, as far as [Dry runs](#dry-runs) says it is enforced; print the email instead of sending it.                                          |
| `timeout_minutes`   | number  | `60`               | The job's timeout.                                                                                                                                                                 |
| `model`             | string  | `claude-opus-5-5`  | The Claude model the triage and lift agents run on, passed to claude-code-action as `--model`. Without it the action picks its own default (Sonnet in the first caller's dry run). |

### Secrets

| secret                    | what it is for                                                                                   | where to get it                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Runs the agent (Claude Code, under your Claude subscription) in `anthropics/claude-code-action`. | Run `claude setup-token` locally and store the token as a repository or organisation secret. |
| `MANDRILL_API_KEY`        | Sends the report email through Mandrill.                                                         | Mailchimp Transactional (Mandrill) → Settings → SMTP & API Info → New API key.               |

Both are required. Only the `report` job sees `MANDRILL_API_KEY`. That job runs on a GitHub-hosted runner, from
a fresh checkout of renovate-doctor, after the triage or lift job has finished. Code that runs in the triage
job - your install, with the updated dependency's install scripts, and every command the agent runs - can
read what that job holds: `CLAUDE_CODE_OAUTH_TOKEN`, the Claude App token and the job's own token. That is
inherent, because the agent needs them. It could also change any later step of that job, which is why the
mail key is not in it at all. The agent works with the Claude GitHub App token that the action mints, plus the
job's own token for one command, `gh run rerun`, because the Claude App asks for read access to Actions at
most. With organisation secrets, a new repository in the same organisation adds no secret of its own.

### Comment authors

The gate treats a head SHA as handled only when the marker comment is by one of the doctor's own accounts:
by default `claude[bot]` (the agent, through the Claude GitHub App) and `github-actions[bot]` (the report job,
with the job token). If your agent comments as another account (a custom GitHub App, say), set the repository
or organisation variable `RENOVATE_DOCTOR_COMMENT_AUTHORS` to the comma-separated logins. A marker by anyone
else is ignored with a `::warning::` naming its author, so a wrong login shows on the first live run's
summary page rather than as a silent second triage of the same head.

### The project-notes file

The skill is generic and is never edited for one project. Everything the agent should know about _your_
repository goes in a notes file, named by `notes_file`. The workflow copies it from your default branch
before checking out the PR head (an older Renovate branch may predate it), and the agent reads the copy right
after the skill; where the two disagree, the notes win. Good things to put in it:

- Packages that are pinned or disabled in the Renovate config, and why, so the agent does not undo them.
- Versions known to be bad, and tests known to flake.
- The package manager to use, and anything the project forbids.
- Where tests go and which runner they use, so a condition test lands in the right place.
- The names of visual-snapshot checks (Chromatic's `UI Tests`, Percy) that must never be approved.
- Services the tests need, for a person running the skill by hand.

A short example:

```markdown
# renovate-doctor notes for example/app

- Use pnpm, never npm. Tests: `pnpm test` (vitest); the database tests need Postgres on `$PGPORT`.
- `pdfjs-dist` is disabled in renovate.json on purpose: the viewer is pinned to the 3.x worker. Leave it alone.
- `googleapis-common` must match the version `googleapis` depends on; update them together.
- Condition tests go in `client/src/util/test/`, named `<package>_hold.test.ts`, using vitest.
- `UI Tests` is the Chromatic check. A Renovate PR that changes snapshots is escalated, never approved.
- `e2e/checkout.spec.ts` flakes on slow runners; one rerun is fine.
```

## Trying it safely

### Dry runs

A dry run rehearses a real triage: the agent reads, reproduces, classifies and makes its fix locally, but
pushes, comments, merges, reruns and opens nothing, and the report job prints the email instead of sending
it. **What enforces that** (the one statement the rest of this README refers to): the gate, which still
requires a failed run on a Renovate PR (conditions 1 and 2) and only reports the others, so you can rehearse
against a closed PR, an old failure or a head that was already handled; the prompt and the skill, which tell
the agent to stop at every write; a deny list that refuses the agent's `git push`, `gh api`,
`gh pr merge`/`create`/`comment`/`edit`/`close`/`review`/`ready`/`reopen`, `gh issue`, `gh label`,
`gh release`, `gh workflow run`, `gh run rerun` and `gh run cancel` commands; and the token that may rerun
jobs, which a dry run does not get. The deny list is best effort: Claude Code's permission rules match the
command text, so `bash -c`, `curl` or a script can get past them, and the Claude App token the agent holds can
write. Rehearse on a PR whose real outcome you would accept.

GitHub starts `workflow_dispatch` only from a workflow file on the default branch ("This event will only
trigger a workflow run if the workflow file exists on the default branch"), and claude-code-action does not
run on `push`, so a caller cannot be rehearsed before it is merged. Adopt it in two steps instead:

1. Merge the caller **without the `workflow_run` trigger**: only `workflow_dispatch` and `schedule`, so it does
   nothing until you dispatch it (the monthly lift aside, which is silent while nothing has expired).
2. Dispatch a dry run against a Renovate PR that failed, from the Actions tab (**Run workflow**) or any
   checkout, and review the transcript artifact and the printed email:

   ```bash
   gh workflow run renovate-doctor.yml -f mode=triage -f pr=123 -f run_id=4567890 -f dry_run=true
   ```

   `run_id` is optional: without it the gate takes the failed runs on the PR's current head.

3. In a second PR, add the `workflow_run` block from the complete caller above. From then on, failures are
   triaged as they happen; the same dispatch still rehearses any PR.

Where to look on the run's page:

- **triage** job, **Gate** step: every condition and the would-be verdict.
- **report** job, **Report** step: the email's subject and body, exactly as they would have been sent.
- Artifact **`renovate-doctor-transcript-<run id>-<attempt>`** (kept 30 days): the agent's full transcript,
  including the diff it would have pushed and the comment it would have posted. Artifact
  **`renovate-doctor-outcome-<run id>-<attempt>`** holds the outcome file the email was built from.

`mode: lift` with `dry_run: true` rehearses the lift. The step that ticks the Dependency Dashboard prints what
it would tick. The lift's diff and PR body are in the transcript artifact, because the lift script runs inside
the agent step (see below), and the report job prints the email.

### Running the skill by hand

The skill is a normal Claude Code skill, so you can run the same procedure on a PR from a local session:

1. In a clone of your project, check out the Renovate branch (`gh pr checkout <n>`) and run your install.
2. Start `claude` there and say: "Follow `<path to renovate-doctor>/skills/renovate-doctor/SKILL.md` for PR
   <n>; notes are in `<notes file>`; this is (or is not) a dry run; write the outcome to `<path>`."
3. Read the outcome file and the comment it posted (or would have posted).

A hand run is not a dry run unless you say so, and its commits count as fix attempts like any other.

### How the lift runs

The lift is a deterministic script, `scripts/lift.mjs`, but the workflow runs it _inside_
`claude-code-action`, with an agent allowed to run exactly that one command. That is the only way to get the
Claude GitHub App token, whose pushes start CI. A lift PR pushed with `GITHUB_TOKEN` would never get its
required checks, and its auto-merge would wait forever. The script writes its result to a file, and the
workflow, not the agent, reads that file to decide the email.

## Guardrails

Stated in the skill and enforced in code where code can enforce them:

- **Only Renovate's PRs**: the gate launches only for a `renovate/` branch whose PR is by `renovate[bot]`, at the
  head SHA that failed, while it is open.
- **Two fix attempts at most**: on the third failure the gate escalates without an agent.
- **Never merge without green checks**: auto-merge only (`--auto --squash`), never `--admin`, never a plain
  merge. The lift enables auto-merge only when the default branch requires status checks (branch protection
  or a ruleset).
- **Never approve visual-snapshot changes**, and never approve a PR.
- **No force-push**, no amending or rewriting a commit that is on the remote.
- **No touching other PRs, branches or issues**, apart from the agent's own `renovate-doctor/hold-*` PR and the
  lift's `renovate-doctor/lift-*` PR.
- **Never widen the update's scope**: change only what the failure needs, through the package manager, without
  skipping tests or silencing the type checker.
- **Never close the Renovate PR.**
- **The agent never holds the mail key**: it lives only in the separate report job, on a GitHub-hosted runner,
  which has `issues` and `pull-requests` permissions and nothing else. The triage job gets only `contents`,
  `pull-requests`, `issues`, `actions` and `id-token`.
- **Dry runs change nothing**, as far as the gate, the prompt, a deny list of GitHub-writing commands and a
  withheld rerun token can enforce it; the deny list is best effort (see [Dry runs](#dry-runs)). The gate never
  launches a dry run on a PR that is not Renovate's.
- **Nothing ever acts on a stale state**: the agent re-checks the PR's state and head before every write, and
  stops (`skipped`) if Renovate moved.

## Known gaps

- **A visual-snapshot change is never approved.** A Renovate PR whose only problem is changed snapshots is
  always escalated, and even a fix the agent pushed waits for a person to accept the snapshots.
- **The lift reads JSON config only.** `renovate.json5`, `.renovaterc` with comments, or a `renovate` key in
  `package.json` are not supported by the lift mode; the agent still triages, but expired holds there are not
  lifted.
- **`rerun_before` is per head SHA.** The agent reruns a head SHA at most once; if that rerun fails again it
  looks a second time, knowing the rerun is spent, and must fix, decline or escalate. A new Renovate push
  (a rebase) starts over with a fresh rerun. A rerun that passes produces no second look, which is the point.
- **A rerun started by the job's own token** is assumed to fire `workflow_run` again when it completes, as the
  first caller's own network-rerun automation already relies on. If it did not, a rerun that failed again
  would get no second look until Renovate pushes again.
- **A dry run's deny list is best effort**, as [Dry runs](#dry-runs) says: it matches command text, so
  `bash -c`, `curl` or a script can get past it, and the App token the agent holds can write. The skill forbids
  working around a refusal. Rehearse on a PR whose real outcome you would accept.
- **Manual and automatic runs on one PR do not share a concurrency group** in the caller above. The manual group
  is keyed by PR number, the automatic one by branch, so a manual dry run can run beside an automatic run. A
  real (not dry) manual run beside an automatic one is safe only because each re-checks the PR before writing.
- **Not supported**: PRs that are not Renovate's, mail providers other than Mandrill, GitHub Enterprise Server
  (the workflow relies on `job.workflow_sha`), and Renovate configs whose holds are not package rules.

## Versions

See [CHANGELOG.md](CHANGELOG.md). Callers pin a tag; every change that a caller could notice gets a new one.

## License

[MIT](LICENSE)
