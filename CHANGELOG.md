# Changelog

Callers pin a tag (`uses: michael-hewitt/renovate-doctor/.github/workflows/renovate-doctor.yml@v0.1.0`); the
workflow checks out its scripts and skill at that tag's commit, so a caller runs exactly the version it pinned
until it moves the pin. Every change a caller could notice gets a new tag and an entry here.

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
