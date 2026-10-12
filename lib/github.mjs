// github - the one way every script talks to GitHub: the `gh` CLI, with retries.
//
// The scripts run on the caller's runner straight from a checkout, with no dependencies installed, so
// they use the `gh` CLI that the runner already has rather than an HTTP client library. `gh` reads
// GH_TOKEN from the environment. Everything goes through `createGithub()`, whose executor tests replace
// with a fake, so no test touches the network.
//
// A self-hosted runner's network can stall for seconds when the box is busy, so every call retries a
// few times with a growing pause. A call GitHub answered with a client error (404, 422 and the like) is
// not retried: asking again cannot change the answer, and the pauses would only delay the failure.

import { execFileSync } from 'node:child_process';

/**
 * @typedef {(file: string, args: string[], options: { input?: string }) => string} Exec
 *   Runs a command and returns its stdout, throwing on a non-zero exit with `stderr` on the error.
 * @typedef {(milliseconds: number) => void} Sleep
 *
 * @typedef {{ method?: string, body?: unknown, paginate?: boolean }} GhApiOptions
 * @typedef {(route: string, options?: GhApiOptions) => any} GhApi
 *   Calls the REST API and returns the parsed JSON. The result is `any`: it is GitHub's JSON, whose shape
 *   the caller knows from the endpoint and reads defensively.
 * @typedef {(args: string[], options?: { input?: string }) => string} Gh
 * @typedef {{ ghApi: GhApi, gh: Gh }} Github
 *   The GitHub adapter every script takes; `createGithub()` builds the real one and tests pass a fake.
 */

/**
 * The REST API's objects, reduced to the fields the scripts read. `ghApi` returns `any`, so a script
 * names one of these where it takes a response apart.
 *
 * @typedef {{
 *   number: number,
 *   html_url: string,
 *   title: string,
 *   state: string,
 *   body?: string | null,
 *   merged_at?: string | null,
 *   created_at: string,
 *   updated_at: string,
 *   closed_at?: string | null,
 *   user?: { login?: string } | null,
 *   head: { ref: string, sha: string, repo?: { full_name?: string } | null },
 * }} PullRequest
 *
 * @typedef {{
 *   id: number,
 *   name: string,
 *   conclusion: string | null,
 *   head_sha: string,
 *   head_branch: string | null,
 *   run_attempt: number,
 *   path: string,
 *   head_repository?: { full_name?: string } | null,
 * }} WorkflowRun
 *
 * @typedef {{ sha: string, author?: { login?: string } | null }} Commit
 *   A PR commit; `author` is the matched GitHub account, null when GitHub could not match one.
 */

/** @type {Exec} */
function defaultExec(file, args, { input } = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** @type {Sleep} Blocks the thread without spawning a process; the scripts are synchronous on purpose. */
function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * `gh` prints "gh: Not Found (HTTP 404)" and the like on a failed API call. 408 and 429 mean "try
 * again later", so they stay retryable along with server errors and anything without a status.
 *
 * @param {any} error
 */
function isClientError(error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  const status = /\(HTTP (\d{3})\)/.exec(text)?.[1];
  return status !== undefined && status.startsWith('4') && status !== '408' && status !== '429';
}

/**
 * `gh api --paginate --slurp` returns an array of pages. List endpoints answer with an array per page,
 * which become one array; the Actions endpoints answer with an object wrapping the list
 * (`{ total_count, jobs: [...] }`), whose list fields are concatenated across pages.
 *
 * @param {any[]} pages
 */
function mergePages(pages) {
  if (pages.every(Array.isArray)) return pages.flat();
  const merged = { ...pages[0] };
  for (const page of pages.slice(1)) {
    for (const [key, value] of Object.entries(page)) {
      if (Array.isArray(value) && Array.isArray(merged[key])) merged[key] = [...merged[key], ...value];
    }
  }
  return merged;
}

/**
 * Builds the GitHub adapter. Production code calls it with no arguments; tests pass a fake `exec`
 * and a `sleep` that does not wait.
 *
 * @param {{ exec?: Exec, sleep?: Sleep, tries?: number, pauseMs?: number }} [options]
 * @returns {Github}
 */
export function createGithub({ exec = defaultExec, sleep = defaultSleep, tries = 4, pauseMs = 10_000 } = {}) {
  /**
   * @template T
   * @param {() => T} attempt
   * @returns {T}
   */
  function withRetries(attempt) {
    for (let i = 1; ; i += 1) {
      try {
        return attempt();
      } catch (error) {
        if (i >= tries || isClientError(error)) throw error;
        sleep(pauseMs * i);
      }
    }
  }

  /**
   * Calls the REST API through `gh api` and returns the parsed JSON, or undefined for an empty body
   * (a 204, say). A `body` is sent as JSON on stdin, so nested objects and arrays arrive intact.
   * `paginate` follows every page and returns the merged result. `route` is e.g.
   * `repos/owner/repo/pulls?state=open&per_page=100`.
   *
   * @type {GhApi}
   */
  function ghApi(route, { method, body, paginate = false } = {}) {
    const args = ['api', route];
    if (method) args.push('--method', method);
    if (paginate) args.push('--paginate', '--slurp');
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined) args.push('--input', '-');
    const stdout = withRetries(() => exec('gh', args, { input }));
    if (!stdout.trim()) return undefined;
    const parsed = JSON.parse(stdout);
    return paginate ? mergePages(parsed) : parsed;
  }

  /**
   * Runs any other `gh` command (`pr merge --auto`, `run rerun`, `pr create`) and returns its stdout.
   *
   * @type {Gh}
   */
  function gh(args, { input } = {}) {
    return withRetries(() => exec('gh', args, { input }));
  }

  return { ghApi, gh };
}

const defaultGithub = createGithub();

/** `ghApi` on the real `gh` CLI; see `createGithub`. */
export const ghApi = defaultGithub.ghApi;

/** `gh` on the real `gh` CLI; see `createGithub`. */
export const gh = defaultGithub.gh;
