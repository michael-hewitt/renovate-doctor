// logs - the failed-job logs of a workflow run, as the gate reads them and the agent receives them.
//
// GitHub publishes a finished run's job logs some time after the run concludes, sometimes minutes later,
// and until then the logs endpoint answers 404. A `workflow_run` event fires as soon as the run
// concludes, so the gate is usually early: it polls each failed job's log for up to about four minutes,
// the same wait a project's rerun automation uses, before giving up on the jobs still missing.
//
// Each failed job contributes its last 600 lines under a header naming the job, which is where a
// failure's cause almost always is and keeps the agent's reading bounded on a job that logged a lot.

import fs from 'node:fs';
import path from 'node:path';

/**
 * A workflow job as the Actions API lists it, reduced to what is read here.
 *
 * @typedef {{ id: number, name: string, conclusion: string | null }} Job
 */

/** @type {Set<string | null>} Job conclusions whose logs explain why the run failed. */
const failedConclusions = new Set(['failure', 'timed_out']);

/** Lines kept from the end of each failed job's log. */
export const tailLines = 600;

/** @type {import('./github.mjs').Sleep} Blocks the thread; the scripts are synchronous (see lib/github.mjs). */
function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * GitHub serves a job log with a byte-order mark at the start, which would otherwise end up glued to the
 * end of the header line above it.
 *
 * @param {string} text
 * @param {number} count
 */
function lastLines(text, count) {
  const lines = text.replace(/^﻿/, '').replace(/\n+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

/**
 * The failed-job logs of run `runId`: for each failed job, a header line `==> <job name> (job <id>) <==`
 * followed by the last 600 lines of its log. Waits for GitHub to publish the logs, polling every
 * `pauseMs` for up to `waitMs`; a job whose log is still missing after that is listed with the reason
 * instead of its lines. Returns an empty string when the run has no failed job (a workflow file error,
 * say), since there is then nothing to wait for.
 *
 * @param {number | string} runId
 * @param {{
 *   github: import('./github.mjs').Github,
 *   repository: string,
 *   sleep?: (milliseconds: number) => void,
 *   waitMs?: number,
 *   pauseMs?: number,
 * }} options
 * @returns {string}
 */
export function fetchFailedLogs(
  runId,
  { github, repository, sleep = defaultSleep, waitMs = 240_000, pauseMs = 20_000 },
) {
  const { jobs = [] } = github.ghApi(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`, { paginate: true });
  /** @type {Job[]} */
  const failedJobs = jobs.filter((/** @type {Job} */ job) => failedConclusions.has(job.conclusion));
  if (failedJobs.length === 0) return '';

  // `gh` 2.97 and later refuse to print a response with terminal escape sequences unless told to allow
  // them (CVE-2026-64654), and a job log is full of them: the runner's own group markers and every
  // tool's colours. Older `gh` (a self-hosted runner's may be 2.45) does not know the flag and fails
  // with "unknown flag", so the first call tries it and the rest of this run's calls remember the answer.
  let allowEscapes = true;
  /** @param {string} route */
  function fetchLog(route) {
    if (allowEscapes) {
      try {
        return github.gh(['api', route, '--allow-escape-sequences']);
      } catch (error) {
        if (!isUnknownFlag(error)) throw error;
        allowEscapes = false;
      }
    }
    return github.gh(['api', route]);
  }

  /** @type {Map<number, string>} */
  const logs = new Map();
  /** @type {Map<number, string>} */
  const missing = new Map();
  /** @type {Set<number>} Jobs whose log failed for a reason waiting does not change. */
  const givenUp = new Set();
  const tries = 1 + Math.floor(waitMs / pauseMs);
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    for (const job of failedJobs) {
      if (logs.has(job.id) || givenUp.has(job.id)) continue;
      try {
        const text = fetchLog(`repos/${repository}/actions/jobs/${job.id}/logs`);
        if (text.trim()) {
          logs.set(job.id, lastLines(text, tailLines));
          missing.delete(job.id);
        } else {
          missing.set(job.id, 'the log is empty');
        }
      } catch (error) {
        // A 404 means "not published yet" and is worth another round. Anything else (a 403, a `gh`
        // refusal) has already been retried by the adapter where that made sense, and another round
        // would only spend the wait: one dry run spent 35 minutes in this loop on a `gh` that refused
        // the log's escape sequences, 13 rounds of 4 adapter tries for each of two runs.
        missing.set(job.id, firstLine(error));
        if (!isNotFound(error)) givenUp.add(job.id);
      }
    }
    if (logs.size + givenUp.size === failedJobs.length || attempt === tries) break;
    sleep(pauseMs);
  }

  return failedJobs
    .map((job) => {
      const header = `==> ${job.name} (job ${job.id}) <==`;
      const body =
        logs.get(job.id) ??
        (givenUp.has(job.id) ? `(no log: ${missing.get(job.id)})` : `(no log after waiting: ${missing.get(job.id)})`);
      return `${header}\n${body}\n`;
    })
    .join('\n');
}

/** @param {any} error */
function errorText(error) {
  return `${error?.stderr ?? ''}\n${error?.message ?? error}`;
}

/** @param {any} error */
function isNotFound(error) {
  return /\(HTTP 404\)/.test(errorText(error));
}

/** @param {any} error */
function isUnknownFlag(error) {
  return /^unknown flag: --allow-escape-sequences/m.test(errorText(error));
}

/** @param {any} error */
function firstLine(error) {
  const text = `${error?.stderr ?? ''}`.trim() || `${error?.message ?? error}`;
  return text.split('\n')[0];
}

/**
 * Writes `text` to `<dir>/<runId>.log`, creating `dir` as needed, and returns the file's path.
 *
 * @param {string} dir
 * @param {number | string} runId
 * @param {string} text
 */
export function writeFailedLogs(dir, runId, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.log`);
  fs.writeFileSync(file, text);
  return file;
}
