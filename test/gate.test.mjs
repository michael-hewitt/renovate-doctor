import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { commentAuthorsFrom, decide, formatOutputs, handledMarker, main, toOutputs } from '../scripts/gate.mjs';

// The fixtures are crescendosw/webapp's real vite-plugin-pwa v2 failure, trimmed: Node.js CI run
// 37993773276 failed on renovate/vite-plugin-pwa-2.x at 457ec6c, and its PR #3814 was later merged at
// eb80467. Tests that need the PR open at the run's head derive that state from the real object.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const text = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');

const repository = 'crescendosw/webapp';
const eventPath = path.join(fixtures, 'workflow_run_event.json');
const event = load('workflow_run_event.json');
const run = event.workflow_run;
const mergedPull = load('pull_3814.json');
const openPull = {
  ...mergedPull,
  state: 'open',
  closed_at: null,
  merged_at: null,
  merged: false,
  merge_commit_sha: null,
  head: { ...mergedPull.head, sha: run.head_sha },
};
const commits = load('pull_3814_commits.json');
const comments = load('issue_comments.json');
const jobs = load('run_37993773276_jobs.json');
const failedRuns = load('runs_failed_on_head.json');
const codeLog = text('job_114034413478.log');
const networkLog = text('job_network.log');
const jobId = jobs.jobs[0].id;

const routes = {
  openPulls: `repos/${repository}/pulls?head=crescendosw%3Arenovate%2Fvite-plugin-pwa-2.x&state=open&per_page=100`,
  allPulls: `repos/${repository}/pulls?head=crescendosw%3Arenovate%2Fvite-plugin-pwa-2.x&state=all&per_page=100`,
  pull: `repos/${repository}/pulls/3814`,
  comments: `repos/${repository}/issues/3814/comments?per_page=100`,
  commits: `repos/${repository}/pulls/3814/commits?per_page=100`,
  failedRuns: (sha) => `repos/${repository}/actions/runs?head_sha=${sha}&status=failure&per_page=100`,
  run: (id) => `repos/${repository}/actions/runs/${id}`,
  jobs: (id) => `repos/${repository}/actions/runs/${id}/jobs?per_page=100`,
  log: (id) => `repos/${repository}/actions/jobs/${id}/logs`,
};

// A commit pushed by someone other than Renovate, shaped like the real commit fixture. The second has no
// matching GitHub account (author null), as a commit with an unregistered email has.
function fixCommit(sha, login) {
  return {
    ...commits[0],
    sha,
    commit: { ...commits[0].commit, message: 'fix(deps): adapt to vite-plugin-pwa v2 (#3814)' },
    author: login ? { login, id: 41898282, type: 'Bot' } : null,
  };
}

// The world as GitHub would answer it, keyed by route; `overrides` replace or add answers. A function
// answer is called (and may throw). Every call is recorded so tests can say what was not asked.
function fakeGithub(overrides = {}) {
  const answers = {
    [routes.openPulls]: [openPull],
    [routes.comments]: comments,
    [routes.commits]: commits,
    [routes.failedRuns(run.head_sha)]: failedRuns,
    [routes.jobs(run.id)]: jobs,
    [routes.log(jobId)]: codeLog,
    ...overrides,
  };
  const answer = (route) => {
    if (!(route in answers)) throw new Error(`unexpected route ${route}`);
    const value = answers[route];
    return structuredClone(typeof value === 'function' ? value() : value);
  };
  const ghApi = vi.fn((route) => answer(route));
  const gh = vi.fn((args) => answer(args[1]));
  return { ghApi, gh, routes: () => [...ghApi.mock.calls.map(([r]) => r), ...gh.mock.calls.map(([a]) => a[1])] };
}

function workflowRun(runOverrides = {}, inputOverrides = {}) {
  return {
    eventName: 'workflow_run',
    event: { ...event, workflow_run: { ...run, ...runOverrides } },
    repository,
    ownWorkflowPath: '.github/workflows/renovate-doctor.yml',
    ...inputOverrides,
  };
}

const sleep = () => {};

describe('decide, on a workflow_run', () => {
  it('launches on a failed run of an open Renovate PR at its head, with the logs for the agent', () => {
    const github = fakeGithub();
    const result = decide(workflowRun(), { github, sleep });
    expect(result).toMatchObject({
      launch: true,
      reason: 'Node.js CI run 37993773276 failed on Renovate PR #3814; 0 fix attempts so far',
      verdict: '',
      outcome: '',
      summary: '',
      prNumber: 3814,
      prUrl: 'https://github.com/crescendosw/webapp/pull/3814',
      prTitle: 'chore(deps): update dependency vite-plugin-pwa to v2',
      headSha: '457ec6c5b51041158be71b2f26907c052d8fe7e9',
      headBranch: 'renovate/vite-plugin-pwa-2.x',
      failedRunIds: [37993773276],
      attempts: 0,
      rerunBefore: false,
    });
    expect(result.checks.map((check) => [check.condition, check.result])).toEqual([
      ['failure', 'pass'],
      ['renovate', 'pass'],
      ['open', 'pass'],
      ['not handled', 'pass'],
      ["rerun automation's turn", 'pass'],
      ['attempts', 'pass'],
    ]);
    expect(Object.keys(result.logs)).toEqual(['37993773276']);
    expect(result.logs[37993773276]).toMatch(/^==> build \(job 114034413478\) <==\n/);
    expect(result.logs[37993773276]).toContain('vite-plugin-pwa 2.0.0 now declares @vite-pwa/assets-generator');
  });

  it('skips a run that did not fail, without asking GitHub anything', () => {
    const github = fakeGithub();
    const result = decide(workflowRun({ conclusion: 'success' }), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('failure: Node.js CI run 37993773276 concluded success, not failure');
    expect(github.routes()).toEqual([]);
  });

  it('skips a branch that is not Renovate’s, without asking GitHub anything', () => {
    const github = fakeGithub();
    const result = decide(workflowRun({ head_branch: 'feature/new-tuner' }), { github, sleep });
    expect(result).toMatchObject({ launch: false, outcome: '' });
    expect(result.reason).toBe('renovate: head branch feature/new-tuner is not a Renovate branch');
    expect(github.routes()).toEqual([]);
  });

  it('skips a renovate/ branch whose PR someone else opened', () => {
    const github = fakeGithub({ [routes.openPulls]: [{ ...openPull, user: { login: 'some-person', type: 'User' } }] });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('renovate: PR #3814 is by some-person, not renovate[bot]');
  });

  it('skips when the PR has been closed', () => {
    const github = fakeGithub({ [routes.openPulls]: [] });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('open: no open PR has head branch renovate/vite-plugin-pwa-2.x');
    expect(result.checks.find((check) => check.condition === 'renovate').result).toBe('unknown');
  });

  it('skips when Renovate has pushed a new head since the run', () => {
    const moved = { ...openPull, head: { ...openPull.head, sha: mergedPull.head.sha } };
    const github = fakeGithub({ [routes.openPulls]: [moved] });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('open: the head moved: run 37993773276 ran on 457ec6c but PR #3814 is at eb80467');
  });

  // A renovate-doctor comment in the real comment's shape, starting with `firstLine`.
  function doctorComment(id, firstLine, outcome) {
    return {
      ...comments[0],
      id,
      html_url: `https://github.com/crescendosw/webapp/pull/3814#issuecomment-${id}`,
      body: `${firstLine}\n**renovate-doctor**\n\nOutcome: ${outcome}\n\nThe hold test fired; ...\n`,
    };
  }

  it('skips a head the doctor has already settled', () => {
    const declined = doctorComment(6091405765, handledMarker(run.head_sha, 'declined'), 'declined');
    const github = fakeGithub({ [routes.comments]: [...comments, declined] });
    const result = decide(workflowRun(), { github, sleep });
    expect(declined.body.startsWith(`<!-- renovate-doctor sha=${run.head_sha} outcome=declined -->\n`)).toBe(true);
    expect(result.launch).toBe(false);
    expect(result.reason).toBe(
      'not handled: PR #3814 already has a renovate-doctor comment for 457ec6c ' +
        '(https://github.com/crescendosw/webapp/pull/3814#issuecomment-6091405765)',
    );
    expect(result.rerunBefore).toBe(false);
  });

  it('reads a marker without an outcome as handled, to stay on the safe side', () => {
    const old = doctorComment(6091405765, `<!-- renovate-doctor sha=${run.head_sha} -->`, 'escalated');
    const result = decide(workflowRun(), { github: fakeGithub({ [routes.comments]: [old] }), sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toMatch(/^not handled: PR #3814 already has a renovate-doctor comment for 457ec6c /);
  });

  it('launches again when its own rerun failed again, and says the rerun already happened', () => {
    const rerun = doctorComment(6091405766, handledMarker(run.head_sha, 'rerun'), 'rerun');
    const github = fakeGithub({ [routes.comments]: [...comments, rerun] });
    const result = decide(workflowRun({ run_attempt: 2 }), { github, sleep });
    expect(result).toMatchObject({ launch: true, rerunBefore: true });
    expect(result.checks.find((check) => check.condition === 'not handled')).toEqual({
      condition: 'not handled',
      result: 'pass',
      detail:
        'renovate-doctor reran 457ec6c on PR #3814 ' +
        '(https://github.com/crescendosw/webapp/pull/3814#issuecomment-6091405766) and it failed again',
    });
    expect(toOutputs(result).rerun_before).toBe('true');
  });

  it('still skips a head settled after a rerun, and ignores markers for other heads', () => {
    const github = fakeGithub({
      [routes.comments]: [
        doctorComment(1, handledMarker(mergedPull.head.sha, 'merged'), 'merged'),
        doctorComment(2, handledMarker(run.head_sha, 'rerun'), 'rerun'),
        doctorComment(3, handledMarker(run.head_sha, 'escalated'), 'escalated'),
      ],
    });
    const result = decide(workflowRun({ run_attempt: 3 }), { github, sleep });
    expect(result).toMatchObject({ launch: false, rerunBefore: true });
    expect(result.reason).toBe(
      'not handled: PR #3814 already has a renovate-doctor comment for 457ec6c ' +
        '(https://github.com/crescendosw/webapp/pull/3814#issuecomment-3)',
    );
  });

  it("leaves a first-attempt network failure to the project's rerun automation", () => {
    const github = fakeGithub({ [routes.log(jobId)]: networkLog });
    const result = decide(workflowRun({}, { rerunWorkflow: 'Rerun network failures' }), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe(
      'rerun automation\'s turn: run 37993773276 attempt 1 failed on the network ("ETIMEDOUT"); ' +
        'Rerun network failures reruns it first, and this runs on attempt 2',
    );
    expect(result.logs).toEqual({});
  });

  it('launches on a first-attempt network failure when the project has no rerun automation', () => {
    const github = fakeGithub({ [routes.log(jobId)]: networkLog });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.launch).toBe(true);
    expect(result.checks.find((check) => check.condition === "rerun automation's turn").detail).toBe(
      'no rerun automation to defer to',
    );
    expect(result.logs[37993773276]).toContain('ERR_PNPM_BROKEN_PNPM_INSTALL');
  });

  it('launches on a second-attempt network failure, after the rerun automation had its turn', () => {
    const github = fakeGithub({ [routes.log(jobId)]: networkLog });
    const result = decide(workflowRun({ run_attempt: 2 }, { rerunWorkflow: 'Rerun network failures' }), {
      github,
      sleep,
    });
    expect(result.launch).toBe(true);
    expect(result.checks.find((check) => check.condition === "rerun automation's turn").detail).toBe(
      'run 37993773276 is attempt 2; Rerun network failures has had its turn',
    );
  });

  it('launches on a first-attempt code failure even with a rerun automation', () => {
    const github = fakeGithub();
    const result = decide(workflowRun({}, { rerunWorkflow: 'Rerun network failures' }), { github, sleep });
    expect(result.launch).toBe(true);
    // The log read for the condition is the one handed to the agent; it is fetched once.
    expect(github.routes().filter((route) => route === routes.log(jobId))).toHaveLength(1);
  });

  it('launches with one fix attempt already on the branch', () => {
    const github = fakeGithub({ [routes.commits]: [...commits, fixCommit('a1b2c3d4e5f6', 'github-actions[bot]')] });
    const result = decide(workflowRun(), { github, sleep });
    expect(result).toMatchObject({ launch: true, attempts: 1 });
    expect(result.reason).toBe('Node.js CI run 37993773276 failed on Renovate PR #3814; 1 fix attempt so far');
  });

  it('escalates instead of launching once two fix attempts are on the branch', () => {
    const github = fakeGithub({
      [routes.commits]: [...commits, fixCommit('a1b2c3d4e5f6', 'github-actions[bot]'), fixCommit('0f9e8d7c6b5a', null)],
    });
    const result = decide(workflowRun(), { github, sleep });
    expect(result).toMatchObject({ launch: false, outcome: 'escalated', attempts: 2, prNumber: 3814 });
    expect(result.reason).toBe(
      'attempts: 2 commits on PR #3814 are by someone other than renovate[bot] (a1b2c3d, 0f9e8d7); ' +
        'fix attempts exhausted',
    );
    expect(result.summary).toMatch(/^Fix attempts exhausted: /);
    expect(result.summary).toContain('Renovate has stopped rebasing this branch');
    expect(result.summary).toContain('ticking the rebase checkbox in the PR description hands the branch back');
    expect(result.logs).toEqual({});
  });

  it('hands the agent every failed run on the head, the triggering one first and its own workflow left out', () => {
    const chromatic = {
      ...failedRuns.workflow_runs[0],
      id: 37993773324,
      name: 'Chromatic',
      path: '.github/workflows/chromatic.yml',
    };
    const doctor = {
      ...failedRuns.workflow_runs[0],
      id: 37993790001,
      name: 'Renovate doctor',
      path: '.github/workflows/renovate-doctor.yml',
      event: 'workflow_run',
    };
    const github = fakeGithub({
      [routes.failedRuns(run.head_sha)]: {
        total_count: 3,
        workflow_runs: [chromatic, doctor, ...failedRuns.workflow_runs],
      },
      [routes.jobs(chromatic.id)]: { total_count: 0, jobs: [] },
    });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.failedRunIds).toEqual([37993773276, 37993773324]);
    expect(Object.keys(result.logs).sort()).toEqual(['37993773276', '37993773324']);
  });

  it('rejects a run from a fork pushing to a same-named Renovate branch, without asking GitHub anything', () => {
    const github = fakeGithub();
    const fork = { id: 987654321, full_name: 'someone/webapp' };
    const result = decide(workflowRun({ head_repository: fork }), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('renovate: run 37993773276 came from fork someone/webapp');
    expect(github.routes()).toEqual([]);
  });

  it("leaves fork runs on the same commit out of the agent's failed runs", () => {
    const forkRun = {
      ...failedRuns.workflow_runs[0],
      id: 37993799999,
      head_repository: { id: 987654321, full_name: 'someone/webapp' },
    };
    const github = fakeGithub({
      [routes.failedRuns(run.head_sha)]: { total_count: 2, workflow_runs: [forkRun, ...failedRuns.workflow_runs] },
    });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.failedRunIds).toEqual([37993773276]);
    expect(Object.keys(result.logs)).toEqual(['37993773276']);
  });

  it("ignores a stranger's marker, launching and warning about it", () => {
    const planted = {
      ...comments[0],
      id: 6091405767,
      html_url: 'https://github.com/crescendosw/webapp/pull/3814#issuecomment-6091405767',
      user: { login: 'some-person', id: 1, type: 'User' },
      body: `Looks fine to me.\n${handledMarker(run.head_sha, 'merged')}\n`,
    };
    const result = decide(workflowRun(), { github: fakeGithub({ [routes.comments]: [planted] }), sleep });
    expect(result.launch).toBe(true);
    expect(result.warnings).toEqual([
      '::warning::renovate-doctor ignored a marker for 457ec6c by some-person, who is not in ' +
        'RENOVATE_DOCTOR_COMMENT_AUTHORS (claude[bot],github-actions[bot]): ' +
        'https://github.com/crescendosw/webapp/pull/3814#issuecomment-6091405767',
    ]);
  });

  it("counts the agent App's marker as settling the head", () => {
    const agent = {
      ...comments[0],
      user: { login: 'claude[bot]', id: 209825114, type: 'Bot' },
      body: `${handledMarker(run.head_sha, 'merged')}\n**renovate-doctor**\n\nOutcome: merged\n`,
    };
    const result = decide(workflowRun(), { github: fakeGithub({ [routes.comments]: [agent] }), sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toMatch(/^not handled: PR #3814 already has a renovate-doctor comment for 457ec6c /);
    expect(result.warnings).toEqual([]);
  });

  it('turns an exception into a skip whose reason starts with gate error', () => {
    const github = fakeGithub({
      [routes.openPulls]: () => {
        throw Object.assign(new Error('Command failed: gh api\ngh: Bad credentials (HTTP 401)'), {
          stderr: 'gh: Bad credentials (HTTP 401)',
        });
      },
    });
    const result = decide(workflowRun(), { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('gate error: Command failed: gh api gh: Bad credentials (HTTP 401)');
    // The report step emails a gate-produced `failed`, so a broken gate is not a silent green run.
    expect(result.outcome).toBe('failed');
    expect(result.summary).toMatch(
      /^The renovate-doctor gate failed, so the agent did not run and nothing was done on the PR: gate error: Command failed: gh api gh: Bad credentials \(HTTP 401\) \(at .+\)\. The run log has the full stack\.$/,
    );
    expect(result.error).toBeInstanceOf(Error);
    expect(result.headBranch).toBe('renovate/vite-plugin-pwa-2.x');
  });
});

describe('decide, on a manual run', () => {
  it.each([false, true])("refuses a run id from another branch than the PR's (dry run %s)", (dryRun) => {
    const elsewhere = { ...run, id: 38000000001, head_branch: 'feature/new-tuner', head_sha: 'c0ffee'.padEnd(40, '0') };
    const github = fakeGithub({ [routes.pull]: openPull, [routes.run(elsewhere.id)]: elsewhere });
    const result = decide(
      { eventName: 'workflow_dispatch', event: {}, repository, pr: 3814, runId: elsewhere.id, dryRun },
      { github, sleep },
    );
    expect(result.launch).toBe(false);
    expect(result.checks.find((check) => check.condition === 'renovate').detail).toBe(
      "run 38000000001 is on feature/new-tuner, not the PR's renovate/vite-plugin-pwa-2.x",
    );
    expect(result.reason).toMatch(
      dryRun
        ? /^dry run: would skip: renovate: run 38000000001 is on feature\/new-tuner, not the PR's /
        : /^renovate: run 38000000001 is on feature\/new-tuner, not the PR's renovate\/vite-plugin-pwa-2\.x$/,
    );
    expect(result.logs).toEqual({});
  });

  it('rehearses a merged PR’s old failed run in a dry run, saying why it would skip', () => {
    const github = fakeGithub({
      [routes.pull]: mergedPull,
      [routes.run(run.id)]: { ...run, pull_requests: [] },
    });
    const result = decide(
      { eventName: 'workflow_dispatch', event: {}, repository, pr: 3814, runId: run.id, dryRun: true },
      { github, sleep },
    );
    expect(result).toMatchObject({
      launch: true,
      outcome: '',
      prNumber: 3814,
      headSha: '457ec6c5b51041158be71b2f26907c052d8fe7e9',
      headBranch: 'renovate/vite-plugin-pwa-2.x',
      failedRunIds: [37993773276],
      attempts: 0,
    });
    expect(result.verdict).toBe(
      'would skip: open: PR #3814 is merged; the head moved: run 37993773276 ran on 457ec6c but PR #3814 is at eb80467',
    );
    expect(result.reason).toBe(`dry run: ${result.verdict}`);
    // Every condition was evaluated, not only those up to the first failure.
    expect(result.checks.map((check) => check.result)).toEqual(['pass', 'pass', 'fail', 'pass', 'pass', 'pass']);
    expect(result.logs[37993773276]).toContain('AssertionError');
  });

  it('says a dry run would escalate, but still launches the rehearsal', () => {
    const github = fakeGithub({
      [routes.pull]: openPull,
      [routes.run(run.id)]: run,
      [routes.commits]: [...commits, fixCommit('a1b2c3d4e5f6', 'github-actions[bot]'), fixCommit('0f9e8d7c6b5a', null)],
    });
    const result = decide(
      { eventName: 'workflow_dispatch', event: {}, repository, pr: 3814, runId: run.id, dryRun: true },
      { github, sleep },
    );
    expect(result).toMatchObject({ launch: true, outcome: '', summary: '', attempts: 2 });
    expect(result.verdict).toMatch(/^would escalate: attempts: 2 commits on PR #3814/);
  });

  it('never launches a dry run on a PR that is not Renovate’s', () => {
    const github = fakeGithub({
      [routes.pull]: { ...openPull, user: { ...openPull.user, login: 'octocat', type: 'User' } },
      [routes.run(run.id)]: run,
    });
    const result = decide(
      { eventName: 'workflow_dispatch', event: {}, repository, pr: 3814, runId: run.id, dryRun: true },
      { github, sleep },
    );
    expect(result).toMatchObject({
      launch: false,
      verdict: 'would skip: renovate: PR #3814 is by octocat, not renovate[bot]',
    });
    expect(result.reason).toBe(`dry run: ${result.verdict} (failure and renovate hold even in a dry run)`);
    // The conditions after the enforced one were not evaluated, so nothing past it was asked of GitHub.
    expect(result.checks.map((check) => check.condition)).toEqual(['failure', 'renovate']);
    expect(github.routes()).toEqual([routes.pull, routes.run(run.id)]);
  });

  it('without a run id, triages every failed run on the PR head', () => {
    const github = fakeGithub({ [routes.pull]: openPull });
    const result = decide({ eventName: 'workflow_dispatch', event: {}, repository, pr: 3814 }, { github, sleep });
    expect(result).toMatchObject({ launch: true, failedRunIds: [37993773276], headSha: run.head_sha });
  });

  it('skips a PR whose head has no failed run', () => {
    const github = fakeGithub({
      [routes.pull]: openPull,
      [routes.failedRuns(run.head_sha)]: { total_count: 0, workflow_runs: [] },
    });
    const result = decide({ eventName: 'workflow_dispatch', event: {}, repository, pr: 3814 }, { github, sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('failure: no run on 457ec6c concluded failure');
  });

  it('takes any other event naming a PR as a manual run', () => {
    const github = fakeGithub({ [routes.pull]: openPull, [routes.run(run.id)]: run });
    const result = decide(
      { eventName: 'push', event: {}, repository, pr: 3814, runId: run.id, dryRun: true },
      { github, sleep },
    );
    expect(result).toMatchObject({ launch: true, prNumber: 3814, failedRunIds: [37993773276] });
    expect(result.verdict).toMatch(/^would launch: /);
  });

  it('refuses a push that names no PR', () => {
    const result = decide({ eventName: 'push', event: {}, repository }, { github: fakeGithub(), sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe(
      'gate error: renovate-doctor triages workflow_run and workflow_dispatch events, not push',
    );
  });

  it('refuses a manual run without a PR', () => {
    const result = decide({ eventName: 'workflow_dispatch', event: {}, repository }, { github: fakeGithub(), sleep });
    expect(result.launch).toBe(false);
    expect(result.reason).toBe('gate error: a manual run needs the pr input (the PR to triage)');
  });
});

describe('formatOutputs', () => {
  it('writes single-line values as key=value and multi-line ones in the heredoc form', () => {
    const delimiter = vi.fn(() => 'EOF_1');
    expect(formatOutputs({ launch: 'false', attempts: 2, summary: 'First line.\nSecond line.' }, { delimiter })).toBe(
      'launch=false\nattempts=2\nsummary<<EOF_1\nFirst line.\nSecond line.\nEOF_1\n',
    );
  });

  it('never uses a delimiter that occurs in the value', () => {
    const delimiter = vi.fn().mockReturnValueOnce('EOF_1').mockReturnValueOnce('EOF_2');
    expect(formatOutputs({ summary: 'a\nEOF_1\nb' }, { delimiter })).toBe('summary<<EOF_2\na\nEOF_1\nb\nEOF_2\n');
  });

  it('emits every key of the contract', () => {
    const github = fakeGithub();
    expect(Object.keys(toOutputs(decide(workflowRun(), { github, sleep })))).toEqual([
      'launch',
      'reason',
      'verdict',
      'outcome',
      'summary',
      'pr_number',
      'pr_url',
      'pr_title',
      'head_sha',
      'head_branch',
      'failed_run_ids',
      'attempts',
      'rerun_before',
    ]);
  });

  it('says no rerun happened when there is no rerun comment', () => {
    expect(toOutputs(decide(workflowRun(), { github: fakeGithub(), sleep })).rerun_before).toBe('false');
  });
});

describe('main', () => {
  function environment(overrides = {}) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-gate-'));
    const output = path.join(temp, 'github_output');
    fs.writeFileSync(output, '');
    return {
      temp,
      output,
      env: {
        GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: repository,
        GITHUB_WORKFLOW_REF: 'crescendosw/webapp/.github/workflows/renovate-doctor.yml@refs/heads/main',
        RUNNER_TEMP: temp,
        INPUT_PR: '0',
        INPUT_RUN_ID: '0',
        INPUT_DRY_RUN: 'false',
        RERUN_WORKFLOW: '',
        GITHUB_OUTPUT: output,
        ...overrides,
      },
    };
  }

  it('prints each condition, writes the logs and appends the outputs', () => {
    const { temp, output, env } = environment();
    const out = vi.fn();
    main({ env, github: fakeGithub(), out, err: vi.fn() });
    const printed = out.mock.calls.map(([line]) => line).join('');
    expect(printed).toContain('[pass] failure: Node.js CI run 37993773276 (attempt 1) concluded failure');
    expect(printed).toContain('[pass] attempts: 0 fix attempts on PR #3814 so far');
    const log = path.join(temp, 'renovate-doctor', 'logs', '37993773276.log');
    expect(fs.readFileSync(log, 'utf8')).toContain('AssertionError');
    const written = fs.readFileSync(output, 'utf8');
    expect(written).toContain('launch=true\n');
    expect(written).toContain('failed_run_ids=37993773276\n');
    expect(written).toContain('head_sha=457ec6c5b51041158be71b2f26907c052d8fe7e9\n');
  });

  it('prints the not-evaluated conditions after a skip', () => {
    const { env } = environment();
    const out = vi.fn();
    main({ env, github: fakeGithub({ [routes.openPulls]: [] }), out, err: vi.fn() });
    const printed = out.mock.calls.map(([line]) => line).join('');
    expect(printed).toContain("[----] rerun automation's turn: not evaluated (an earlier condition decided)");
    expect(printed).toContain('Launch: false. open: no open PR has head branch renovate/vite-plugin-pwa-2.x');
  });

  it('trusts the authors RENOVATE_DOCTOR_COMMENT_AUTHORS names instead, and prints the warning', () => {
    const { env } = environment({ RENOVATE_DOCTOR_COMMENT_AUTHORS: ' renovate-doctor-app[bot] , claude[bot] ' });
    const byJobToken = {
      ...comments[0],
      body: `${handledMarker(run.head_sha, 'escalated')}\n**renovate-doctor**\n\nOutcome: escalated\n`,
    };
    const out = vi.fn();
    const result = main({ env, github: fakeGithub({ [routes.comments]: [byJobToken] }), out, err: vi.fn() });
    expect(result.launch).toBe(true);
    const printed = out.mock.calls.map(([line]) => line).join('');
    expect(printed).toContain(
      '::warning::renovate-doctor ignored a marker for 457ec6c by github-actions[bot], who is not in ' +
        'RENOVATE_DOCTOR_COMMENT_AUTHORS (renovate-doctor-app[bot],claude[bot]): ',
    );
  });

  it('falls back to the default authors when the variable is unset or empty', () => {
    expect(commentAuthorsFrom(undefined)).toEqual(['claude[bot]', 'github-actions[bot]']);
    expect(commentAuthorsFrom(' , ')).toEqual(['claude[bot]', 'github-actions[bot]']);
    expect(commentAuthorsFrom('a[bot],b')).toEqual(['a[bot]', 'b']);
  });

  it('reports a gate error as launch=false, with the stack on stderr, and returns normally', () => {
    const { output, env } = environment({ GITHUB_EVENT_PATH: path.join(fixtures, 'missing.json') });
    const err = vi.fn();
    const result = main({ env, github: fakeGithub(), out: vi.fn(), err });
    expect(result.launch).toBe(false);
    const written = fs.readFileSync(output, 'utf8');
    expect(written).toMatch(/^launch=false\nreason=gate error: ENOENT/);
    expect(written).toContain('\noutcome=failed\n');
    expect(written).toMatch(/\nsummary=The renovate-doctor gate failed, .*ENOENT.*\n/);
    expect(err.mock.calls[0][0]).toMatch(/renovate-doctor gate error:\nError: ENOENT[^]*\n {4}at /);
  });
});
