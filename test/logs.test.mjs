import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createGithub } from '../lib/github.mjs';
import { fetchFailedLogs, tailLines, writeFailedLogs } from '../lib/logs.mjs';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const repository = 'crescendosw/webapp';
const runId = 37993773276;
const jobsRoute = `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`;
const logRoute = (/** @type {number} */ jobId) => `repos/${repository}/actions/jobs/${jobId}/logs`;

// The real jobs list of crescendosw/webapp run 37993773276 (vite-plugin-pwa v2 failing a hold test), and
// the tail of its one failed job's log as GitHub serves it, byte-order mark included.
const jobs = JSON.parse(fs.readFileSync(path.join(fixtures, 'run_37993773276_jobs.json'), 'utf8'));
const jobLog = fs.readFileSync(path.join(fixtures, 'job_114034413478.log'), 'utf8');
const failedJob = jobs.jobs[0];

function notFound() {
  return Object.assign(new Error('Command failed: gh api\ngh: Not Found (HTTP 404)'), {
    status: 1,
    stderr: 'gh: Not Found (HTTP 404)\n',
  });
}

// The real adapter on a fake `gh`: `answers` maps an API route to its stdout, or to a function returning
// it (or throwing, as `gh` does on an HTTP error).
/** @param {Record<string, string | (() => string)>} answers */
function fakeGithub(answers) {
  const exec = vi.fn((/** @type {string} */ _file, /** @type {string[]} */ args) => {
    const answer = answers[args[1]];
    if (answer === undefined) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    return typeof answer === 'function' ? answer() : answer;
  });
  return { github: createGithub({ exec, sleep: () => {} }), exec };
}

describe('fetchFailedLogs', () => {
  it("returns each failed job's log under a header naming the job", () => {
    const { github } = fakeGithub({ [jobsRoute]: JSON.stringify([jobs]), [logRoute(failedJob.id)]: jobLog });
    const sleep = vi.fn();
    const text = fetchFailedLogs(runId, { github, repository, sleep });
    expect(text.startsWith('==> build (job 114034413478) <==\n2026-10-09T21:36:44.7751153Z Current runner')).toBe(true);
    expect(text).toContain('AssertionError: vite-plugin-pwa 2.0.0 now declares @vite-pwa/assets-generator');
    expect(text).not.toContain('﻿');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reads only failed jobs, in the order GitHub lists them', () => {
    const passed = { ...failedJob, id: 1, name: 'lint', conclusion: 'success' };
    const timedOut = { ...failedJob, id: 2, name: 'e2e', conclusion: 'timed_out' };
    const { github, exec } = fakeGithub({
      [jobsRoute]: JSON.stringify([{ total_count: 3, jobs: [passed, failedJob, timedOut] }]),
      [logRoute(failedJob.id)]: jobLog,
      [logRoute(2)]:
        '2026-10-09T21:50:00.0000000Z ##[error]The job running on runner x has exceeded the maximum execution time',
    });
    const text = fetchFailedLogs(runId, { github, repository });
    expect(text.match(/^==> .* <==$/gm)).toEqual(['==> build (job 114034413478) <==', '==> e2e (job 2) <==']);
    expect(exec.mock.calls.map(([, args]) => args[1])).not.toContain(logRoute(1));
  });

  it('keeps only the last 600 lines of a long log', () => {
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const { github } = fakeGithub({ [jobsRoute]: JSON.stringify([jobs]), [logRoute(failedJob.id)]: long });
    const lines = fetchFailedLogs(runId, { github, repository }).trimEnd().split('\n');
    expect(lines).toHaveLength(tailLines + 1);
    expect(lines[1]).toBe('line 401');
    expect(lines.at(-1)).toBe('line 1000');
  });

  it('waits for GitHub to publish a log that is not there yet', () => {
    let calls = 0;
    const { github } = fakeGithub({
      [jobsRoute]: JSON.stringify([jobs]),
      [logRoute(failedJob.id)]: () => {
        calls += 1;
        if (calls < 3) throw notFound();
        return jobLog;
      },
    });
    const sleep = vi.fn();
    const text = fetchFailedLogs(runId, { github, repository, sleep });
    expect(text).toContain('AssertionError');
    expect(sleep.mock.calls).toEqual([[20_000], [20_000]]);
  });

  it('gives up after about four minutes and says which log is missing', () => {
    const { github, exec } = fakeGithub({
      [jobsRoute]: JSON.stringify([jobs]),
      [logRoute(failedJob.id)]: () => {
        throw notFound();
      },
    });
    const sleep = vi.fn();
    const text = fetchFailedLogs(runId, { github, repository, sleep });
    expect(text).toBe('==> build (job 114034413478) <==\n(no log after waiting: gh: Not Found (HTTP 404))\n');
    expect(sleep).toHaveBeenCalledTimes(12);
    expect(sleep.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBe(240_000);
    // One jobs listing plus thirteen tries at the log, none of them retried inside the adapter.
    expect(exec).toHaveBeenCalledTimes(14);
  });

  it('returns nothing, without waiting, for a run with no failed job', () => {
    const { github } = fakeGithub({ [jobsRoute]: JSON.stringify([{ total_count: 0, jobs: [] }]) });
    const sleep = vi.fn();
    expect(fetchFailedLogs(runId, { github, repository, sleep })).toBe('');
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('writeFailedLogs', () => {
  it('writes <dir>/<run id>.log, creating the directory', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-')), 'renovate-doctor', 'logs');
    const file = writeFailedLogs(dir, runId, '==> build (job 1) <==\nboom\n');
    expect(file).toBe(path.join(dir, '37993773276.log'));
    expect(fs.readFileSync(file, 'utf8')).toBe('==> build (job 1) <==\nboom\n');
  });
});
