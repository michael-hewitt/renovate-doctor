// gate - decides whether a failed CI run on a Renovate PR gets the agent, and says why.
//
// The triage job's first real step. It runs on the caller's runner from the checkout in
// `.renovate-doctor`, looks at the failed run and its PR, and evaluates the six conditions of the gate
// contract in docs/architecture.md, in order: failure, renovate, open, not handled, rerun automation's
// turn, attempts. The first condition that fails is the reason to skip. When the branch already carries
// two fix attempts, the gate produces the `escalated` outcome itself so the report step can email and
// comment without an agent. When the gate launches, it also writes each failed run's failed-job logs to
// `$RUNNER_TEMP/renovate-doctor/logs/<run_id>.log` for the agent.
//
// Environment: GITHUB_EVENT_NAME (`workflow_run` or `workflow_dispatch`), GITHUB_EVENT_PATH,
// GITHUB_REPOSITORY, GH_TOKEN (read by `gh`), RUNNER_TEMP, INPUT_PR, INPUT_RUN_ID, INPUT_DRY_RUN
// (`true`/`false`), RERUN_WORKFLOW, GITHUB_OUTPUT, and GITHUB_WORKFLOW_REF (set by Actions; it names the
// caller's own workflow file, whose failed runs are not CI failures to triage).
//
// The script always exits 0. A gate that crashed must still let the report step run and must never
// launch the agent, so any exception becomes `launch=false` with `reason=gate error: ...`, and the stack
// goes to stderr for whoever reads the run.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGithub } from '../lib/github.mjs';
import { fetchFailedLogs, writeFailedLogs } from '../lib/logs.mjs';
import { matchNetworkSignature } from '../lib/network_signature.mjs';

const renovateBot = 'renovate[bot]';

/** The conditions in the order the contract evaluates them; each skip reason starts with one. */
export const conditions = ['failure', 'renovate', 'open', 'not handled', "rerun automation's turn", 'attempts'];

/** Two fix commits on a branch are enough; a third would only loop with CI. */
const maxAttempts = 2;

/** The PR-comment marker every renovate-doctor comment for `sha` starts with. */
export function handledMarker(sha) {
  return `<!-- renovate-doctor sha=${sha} -->`;
}

/**
 * @typedef {{
 *   eventName: string,
 *   event: any,
 *   repository: string,
 *   pr?: number,
 *   runId?: number,
 *   dryRun?: boolean,
 *   rerunWorkflow?: string,
 *   ownWorkflowPath?: string,
 * }} GateInput
 *
 * @typedef {{ condition: string, result: 'pass' | 'fail' | 'unknown', detail: string }} Check
 *
 * @typedef {{
 *   launch: boolean,
 *   reason: string,
 *   verdict: string,
 *   outcome: string,
 *   summary: string,
 *   prNumber: number | '',
 *   prUrl: string,
 *   prTitle: string,
 *   headSha: string,
 *   headBranch: string,
 *   failedRunIds: number[],
 *   attempts: number | '',
 *   checks: Check[],
 *   logs: Record<string, string>,
 *   error?: Error,
 * }} GateResult
 */

function blankResult() {
  return {
    launch: false,
    reason: '',
    verdict: '',
    outcome: '',
    summary: '',
    prNumber: /** @type {number | ''} */ (''),
    prUrl: '',
    prTitle: '',
    headSha: '',
    headBranch: '',
    failedRunIds: /** @type {number[]} */ ([]),
    attempts: /** @type {number | ''} */ (''),
    checks: /** @type {Check[]} */ ([]),
    logs: /** @type {Record<string, string>} */ ({}),
  };
}

function oneLine(text) {
  return `${text}`.replace(/\s*\n\s*/g, ' ').trim();
}

function short(sha) {
  return `${sha ?? ''}`.slice(0, 7);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Decides whether the agent launches. Pure apart from the GitHub adapter (and the log wait's `sleep`),
 * so tests drive it with a fake adapter. Never throws: an exception becomes a `gate error` result
 * carrying the error, with whatever had been resolved before it.
 *
 * @param {GateInput} input
 * @param {{
 *   github: { ghApi: Function, gh: Function },
 *   sleep?: (milliseconds: number) => void,
 *   logWaitMs?: number,
 *   logPauseMs?: number,
 * }} deps
 * @returns {GateResult}
 */
export function decide(input, deps) {
  const result = blankResult();
  try {
    return evaluate(input, deps, result);
  } catch (error) {
    return { ...result, launch: false, reason: `gate error: ${oneLine(error?.message ?? error)}`, verdict: '', error };
  }
}

/** The result for an exception raised before `decide` could run (an unreadable event file, say). */
export function gateErrorResult(error) {
  return { ...blankResult(), reason: `gate error: ${oneLine(error?.message ?? error)}`, error };
}

function evaluate(input, { github, sleep, logWaitMs, logPauseMs }, result) {
  const { eventName, event, repository, dryRun = false, rerunWorkflow = '', ownWorkflowPath = '' } = input;
  if (!repository || !repository.includes('/')) throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
  const owner = repository.split('/')[0];

  /** @type {Map<number, string>} */
  const logCache = new Map();
  function logsOf(runId) {
    if (!logCache.has(runId)) {
      const text = fetchFailedLogs(runId, { github, repository, sleep, waitMs: logWaitMs, pauseMs: logPauseMs });
      logCache.set(runId, text);
    }
    return logCache.get(runId);
  }

  // Every failed run on a commit, the caller's own renovate-doctor workflow excluded: a doctor run that
  // failed is not a CI failure, and the agent must not be pointed at itself.
  function failedRunsOn(sha) {
    const { workflow_runs: runs = [] } = github.ghApi(
      `repos/${repository}/actions/runs?head_sha=${sha}&status=failure&per_page=100`,
      { paginate: true },
    );
    return runs.filter((run) => run.conclusion === 'failure' && !(ownWorkflowPath && run.path === ownWorkflowPath));
  }

  /** The first failed condition, as `<condition>: <detail>`. */
  let firstFailure = '';
  let firstFailedCondition = '';
  /** Records a condition and says whether to carry on: always in a dry run, otherwise only past a pass. */
  function record(condition, pass, detail) {
    result.checks.push({ condition, result: pass === undefined ? 'unknown' : pass ? 'pass' : 'fail', detail });
    if (pass === false && !firstFailure) {
      firstFailure = `${condition}: ${detail}`;
      firstFailedCondition = condition;
    }
    return pass !== false || dryRun;
  }
  function skip() {
    result.launch = false;
    result.reason = firstFailure;
    return result;
  }
  function setPr(pr) {
    result.prNumber = pr.number;
    result.prUrl = pr.html_url;
    result.prTitle = pr.title;
  }

  // Resolve the failed run (the triggering one, or the one a manual run names) and, where the event
  // names it, the PR.
  let run;
  let pr;
  /** @type {any[] | undefined} */
  let failedRuns;
  if (eventName === 'workflow_run') {
    run = event?.workflow_run;
    if (!run) throw new Error('the workflow_run event payload has no workflow_run');
    result.headSha = run.head_sha;
    result.headBranch = run.head_branch;
    result.failedRunIds = [run.id];
  } else if (eventName === 'workflow_dispatch') {
    if (!input.pr) throw new Error('a manual run needs the pr input (the PR to triage)');
    pr = github.ghApi(`repos/${repository}/pulls/${input.pr}`);
    setPr(pr);
    result.headBranch = pr.head.ref;
    if (input.runId) {
      run = github.ghApi(`repos/${repository}/actions/runs/${input.runId}`);
      failedRuns = run.conclusion === 'failure' ? [run] : [];
      result.headSha = run.head_sha;
    } else {
      failedRuns = failedRunsOn(pr.head.sha);
      run = failedRuns[0];
      result.headSha = pr.head.sha;
    }
    result.failedRunIds = failedRuns.map((failed) => failed.id);
  } else {
    throw new Error(`renovate-doctor triages workflow_run and workflow_dispatch events, not ${eventName || 'none'}`);
  }
  const branch = result.headBranch ?? '';

  // 1. failure
  const failed = run?.conclusion === 'failure';
  let failureDetail;
  if (failed) failureDetail = `${run.name} run ${run.id} (attempt ${run.run_attempt}) concluded failure`;
  else if (run) failureDetail = `${run.name} run ${run.id} concluded ${run.conclusion ?? 'nothing yet'}, not failure`;
  else failureDetail = `no run on ${short(result.headSha)} concluded failure`;
  if (!record('failure', failed, failureDetail)) return skip();

  // 2. renovate. In a workflow_run the PR is found from the branch, which only makes sense once the
  // branch is Renovate's; the author is checked as soon as there is a PR to read it from.
  const renovateBranch = branch.startsWith('renovate/');
  /** @type {any[] | undefined} */
  let openPrs;
  if (eventName === 'workflow_run' && (renovateBranch || dryRun)) {
    const head = encodeURIComponent(`${owner}:${branch}`);
    openPrs = github.ghApi(`repos/${repository}/pulls?head=${head}&state=open&per_page=100`);
    if (openPrs.length === 1) pr = openPrs[0];
    else if (openPrs.length === 0 && dryRun) {
      // A rehearsal may target a branch whose PR has since closed or merged: the most recent one will do.
      [pr] = github.ghApi(`repos/${repository}/pulls?head=${head}&state=all&per_page=100`);
    }
    if (pr) setPr(pr);
  }
  const author = pr?.user?.login;
  let renovatePass;
  let renovateDetail;
  if (!renovateBranch) {
    renovatePass = false;
    renovateDetail = `head branch ${branch || '(none)'} is not a Renovate branch`;
  } else if (pr && author !== renovateBot) {
    renovatePass = false;
    renovateDetail = `PR #${pr.number} is by ${author}, not ${renovateBot}`;
  } else if (pr) {
    renovatePass = true;
    renovateDetail = `head branch ${branch}, PR #${pr.number} by ${renovateBot}`;
  } else {
    renovatePass = undefined;
    renovateDetail = `head branch ${branch}; no PR to read the author from (see open)`;
  }
  if (!record('renovate', renovatePass, renovateDetail)) return skip();

  // 3. open
  const problems = [];
  if (eventName === 'workflow_run' && openPrs && openPrs.length > 1) {
    problems.push(`${openPrs.length} open PRs have head branch ${branch}`);
  } else if (!pr) {
    problems.push(`no open PR has head branch ${branch}`);
  } else if (pr.state !== 'open') {
    problems.push(`PR #${pr.number} is ${pr.merged_at ? 'merged' : 'closed'}`);
  }
  if (pr && run && pr.head.sha !== run.head_sha) {
    problems.push(
      `the head moved: run ${run.id} ran on ${short(run.head_sha)} but PR #${pr.number} is at ${short(pr.head.sha)}`,
    );
  }
  const openDetail = problems.length
    ? problems.join('; ')
    : `PR #${pr.number} is open at ${short(pr.head.sha)}, the failed run's head`;
  if (!record('open', problems.length === 0, openDetail)) return skip();

  // 4. not handled
  if (pr) {
    const comments = github.ghApi(`repos/${repository}/issues/${pr.number}/comments?per_page=100`, {
      paginate: true,
    });
    const marker = handledMarker(result.headSha);
    const handled = comments.find((comment) => comment.body?.includes(marker));
    const detail = handled
      ? `PR #${pr.number} already has a renovate-doctor comment for ${short(result.headSha)} (${handled.html_url})`
      : `no renovate-doctor comment for ${short(result.headSha)} on PR #${pr.number}`;
    if (!record('not handled', !handled, detail)) return skip();
  } else {
    record('not handled', undefined, 'no PR to read comments from');
  }

  // 5. rerun automation's turn. Only a first attempt is the rerun automation's, so the log (and its
  // publish wait) is fetched only then.
  if (!rerunWorkflow) {
    record("rerun automation's turn", true, 'no rerun automation to defer to');
  } else if (!run) {
    record("rerun automation's turn", undefined, 'no failed run to read');
  } else if (run.run_attempt !== 1) {
    record(
      "rerun automation's turn",
      true,
      `run ${run.id} is attempt ${run.run_attempt}; ${rerunWorkflow} has had its turn`,
    );
  } else {
    const match = matchNetworkSignature(logsOf(run.id));
    const detail = match
      ? `run ${run.id} attempt 1 failed on the network ("${match}"); ${rerunWorkflow} reruns it first, and this runs on attempt 2`
      : `no network-failure signature in run ${run.id}'s failed-job log`;
    if (!record("rerun automation's turn", !match, detail)) return skip();
  }

  // 6. attempts
  let fixCommits;
  if (pr) {
    const commits = github.ghApi(`repos/${repository}/pulls/${pr.number}/commits?per_page=100`, { paginate: true });
    // A commit whose author GitHub could not match to an account (author null) is not Renovate's.
    fixCommits = commits.filter((commit) => commit.author?.login !== renovateBot);
    result.attempts = fixCommits.length;
    const listed = fixCommits.map((commit) => short(commit.sha)).join(', ');
    const detail =
      fixCommits.length >= maxAttempts
        ? `${plural(fixCommits.length, 'commit')} on PR #${pr.number} are by someone other than ${renovateBot} (${listed}); fix attempts exhausted`
        : `${plural(fixCommits.length, 'fix attempt')} on PR #${pr.number} so far${listed ? ` (${listed})` : ''}`;
    record('attempts', fixCommits.length < maxAttempts, detail);
  } else {
    record('attempts', undefined, 'no PR to count commits on');
  }
  const exhausted = fixCommits !== undefined && fixCommits.length >= maxAttempts;

  // Outside a dry run the gate gets here only when every condition up to attempts held.
  if (!dryRun && exhausted) {
    result.launch = false;
    result.reason = firstFailure;
    result.outcome = 'escalated';
    result.summary = escalationSummary(pr, run, fixCommits);
    return result;
  }

  // The agent looks at every failed run on the head, the triggering one first.
  if (eventName === 'workflow_run' && failed && result.headSha) {
    const others = failedRunsOn(result.headSha).filter((other) => other.id !== run.id);
    result.failedRunIds = [run.id, ...others.map((other) => other.id)];
  } else if (eventName === 'workflow_run') {
    result.failedRunIds = [];
  }

  if (dryRun) {
    const resolved = Boolean(pr) && result.failedRunIds.length > 0;
    if (!firstFailure) result.verdict = `would launch: ${launchReason(pr, run, result.attempts)}`;
    else if (firstFailedCondition === 'attempts') result.verdict = `would escalate: ${firstFailure}`;
    else result.verdict = `would skip: ${firstFailure}`;
    result.launch = resolved;
    result.reason = resolved
      ? `dry run: ${result.verdict}`
      : `dry run: nothing to rehearse (${pr ? 'no failed run' : 'no PR'}); ${result.verdict}`;
  } else {
    result.launch = true;
    result.reason = launchReason(pr, run, result.attempts);
  }

  if (result.launch) {
    for (const runId of result.failedRunIds) {
      try {
        result.logs[runId] = logsOf(runId);
      } catch (error) {
        // The agent can read the log itself; a missing copy is no reason to keep it from the PR.
        result.logs[runId] =
          `(renovate-doctor could not fetch run ${runId}'s failed-job logs: ${oneLine(error?.message ?? error)}; ` +
          `read them with gh run view ${runId} --log-failed)\n`;
      }
    }
  }
  return result;
}

function launchReason(pr, run, attempts) {
  return `${run.name} run ${run.id} failed on Renovate PR #${pr.number}; ${plural(attempts || 0, 'fix attempt')} so far`;
}

function escalationSummary(pr, run, fixCommits) {
  const listed = fixCommits.map((commit) => short(commit.sha)).join(', ');
  return (
    `Fix attempts exhausted: ${pr.title} (#${pr.number}) already carries ${plural(fixCommits.length, 'commit')} ` +
    `by someone other than ${renovateBot} (${listed}), and ${run.name} still fails on ${short(run.head_sha)}, ` +
    'so renovate-doctor did not try a third fix. Renovate has stopped rebasing this branch because someone else ' +
    'committed to it; ticking the rebase checkbox in the PR description hands the branch back to Renovate, which ' +
    'rebuilds it from the default branch without those commits. Until then the update needs a person.'
  );
}

/**
 * Formats outputs for `$GITHUB_OUTPUT`: `key=value` lines, and the heredoc form `key<<DELIMITER` for a
 * value that spans lines, with a delimiter that cannot occur in the value.
 *
 * @param {Record<string, string | number | boolean>} outputs
 * @param {{ delimiter?: () => string }} [options]
 */
export function formatOutputs(outputs, { delimiter = () => `RENOVATE_DOCTOR_EOF_${randomUUID()}` } = {}) {
  let text = '';
  for (const [key, raw] of Object.entries(outputs)) {
    const value = `${raw ?? ''}`;
    if (!value.includes('\n') && !value.includes('\r')) {
      text += `${key}=${value}\n`;
      continue;
    }
    let marker = delimiter();
    while (value.includes(marker)) marker = delimiter();
    text += `${key}<<${marker}\n${value}\n${marker}\n`;
  }
  return text;
}

/** The gate's result as the `$GITHUB_OUTPUT` keys the contract names. */
export function toOutputs(result) {
  return {
    launch: result.launch ? 'true' : 'false',
    reason: oneLine(result.reason),
    verdict: result.verdict,
    outcome: result.outcome,
    summary: result.summary,
    pr_number: result.prNumber,
    pr_url: result.prUrl,
    pr_title: result.prTitle,
    head_sha: result.headSha,
    head_branch: result.headBranch,
    failed_run_ids: result.failedRunIds.join(','),
    attempts: result.attempts,
  };
}

// Four characters each, so the condition names line up in the job log.
const labels = { pass: 'pass', fail: 'fail', unknown: '????' };

/** The readable account of the decision, one line per condition, printed to the job log. */
export function describeDecision(result, { dryRun = false } = {}) {
  const lines = [`renovate-doctor gate${dryRun ? ' (dry run)' : ''}:`];
  const byCondition = new Map(result.checks.map((check) => [check.condition, check]));
  for (const condition of conditions) {
    const check = byCondition.get(condition);
    if (!check) {
      lines.push(`  [----] ${condition}: not evaluated${result.error ? '' : ' (an earlier condition decided)'}`);
      continue;
    }
    lines.push(`  [${labels[check.result]}] ${condition}: ${check.detail}`);
  }
  if (result.verdict) lines.push(`Verdict: ${result.verdict}`);
  lines.push(`Launch: ${result.launch}. ${result.reason}`);
  if (result.outcome) lines.push(`Outcome: ${result.outcome}. ${result.summary}`);
  return `${lines.join('\n')}\n`;
}

// GITHUB_WORKFLOW_REF is `owner/repo/.github/workflows/<file>@<ref>`; the path is what a run reports.
function workflowPath(workflowRef, repository) {
  if (!workflowRef) return '';
  const withoutRef = workflowRef.replace(/@.*$/, '');
  return withoutRef.startsWith(`${repository}/`) ? withoutRef.slice(repository.length + 1) : '';
}

function readInput(env) {
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const repository = env.GITHUB_REPOSITORY ?? '';
  return {
    eventName,
    event,
    repository,
    pr: Number(env.INPUT_PR || 0),
    runId: Number(env.INPUT_RUN_ID || 0),
    dryRun: env.INPUT_DRY_RUN === 'true',
    rerunWorkflow: env.RERUN_WORKFLOW ?? '',
    ownWorkflowPath: workflowPath(env.GITHUB_WORKFLOW_REF, repository),
  };
}

/**
 * Runs the gate from the environment: decides, prints, writes the logs and the outputs. Never throws
 * and never sets a failing exit code.
 *
 * @param {{ env?: NodeJS.ProcessEnv, github?: { ghApi: Function, gh: Function }, out?: (text: string) => void, err?: (text: string) => void }} [options]
 */
export function main({
  env = process.env,
  github = createGithub(),
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  let input;
  let result;
  try {
    input = readInput(env);
    result = decide(input, { github });
  } catch (error) {
    result = gateErrorResult(error);
  }
  if (result.error) err(`renovate-doctor gate error:\n${result.error?.stack ?? result.error}\n`);

  out(describeDecision(result, { dryRun: input?.dryRun }));

  try {
    const logDir = path.join(env.RUNNER_TEMP || os.tmpdir(), 'renovate-doctor', 'logs');
    for (const [runId, text] of Object.entries(result.logs)) {
      const file = writeFailedLogs(logDir, runId, text);
      out(`Wrote run ${runId}'s failed-job logs to ${file}\n`);
    }
  } catch (error) {
    err(`renovate-doctor gate could not write the failed-job logs:\n${error?.stack ?? error}\n`);
  }

  const outputs = formatOutputs(toOutputs(result));
  try {
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputs);
    else out(`GITHUB_OUTPUT is not set; the outputs would be:\n${outputs}`);
  } catch (error) {
    err(`renovate-doctor gate could not write $GITHUB_OUTPUT:\n${error?.stack ?? error}\n`);
  }
  return result;
}

const invokedDirectly =
  process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);

if (invokedDirectly) main();
