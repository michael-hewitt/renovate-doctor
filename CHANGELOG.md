# Changelog

Callers pin a tag (`uses: michael-hewitt/renovate-doctor/.github/workflows/renovate-doctor.yml@v0.1.0`); the
workflow checks out its scripts and skill at that tag's commit, so a caller runs exactly the version it pinned
until it moves the pin. Every change a caller could notice gets a new tag and an entry here.

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
