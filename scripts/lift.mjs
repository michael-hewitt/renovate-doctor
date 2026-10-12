// lift - remove the Renovate holds whose date has come, with their condition tests, in one auto-merged PR.
//
// The lift job's main step, run monthly from the caller's default-branch checkout. A dated hold is a
// disabled package rule whose description carries `remove after YYYY-MM-DD: <why>`; when that date is
// today or earlier the hold has expired. This script removes every expired hold from the config, deletes
// the condition tests guarding them (test files carrying the line `renovate-doctor hold: <package>`),
// commits that on `renovate-doctor/lift-<today>`, pushes, opens a PR carrying `<!-- renovate-doctor lift -->`
// and enables squash auto-merge, so a dated retry never waits on a person. Auto-merge is enabled only when
// the default branch requires status checks (branch protection or a ruleset): without them it would merge
// before CI has run, so the PR is left for a person and the summary says so. When the branch already has an
// open PR (a rerun of the same day's job), that PR is reused rather than opened again; when another lift
// PR is still open, nothing is lifted (`blocked`), because a second PR would lift the same holds again.
// Only PRs from this repository's own branches count: the branch name is predictable, and a fork's PR
// named like it must never be reused, let alone set to auto-merge. A
// dry run makes the same edits in the working tree, prints the diff and the PR body, and then puts the
// files back; it touches nothing on GitHub.
//
// Usage: node scripts/lift.mjs [--today YYYY-MM-DD] [--dry-run]
//
// Environment: GITHUB_REPOSITORY, GH_TOKEN (read by `gh`), GITHUB_OUTPUT, RUNNER_TEMP, RENOVATE_CONFIG
// (the config's path in the checkout, default `renovate.json`). The push uses the checkout's own
// credentials.
//
// It must run with a token whose pushes start workflows - the Claude GitHub App token, which
// `claude-code-action` exports as GH_TOKEN when the script runs from inside it - because pushes and PRs
// made with GITHUB_TOKEN never trigger CI, so the PR's required checks would never run and auto-merge
// would wait forever.
//
// Outputs (`$GITHUB_OUTPUT`): `opened` (`true`/`false`), `blocked` (`true` when an earlier lift PR is
// still open; `pr_url` is then that PR), `pr_url`, `packages` (comma-separated), `removed` (the number of
// holds, that is rules, removed or, in a dry run, to be removed; a rule matched by prefix names no package,
// so `packages` alone can be empty when something was lifted), `summary` (one line, for the email
// subject). The same outputs, with the script's `exit_code`, also go to `$RUNNER_TEMP/renovate-doctor/lift.json`
// when RUNNER_TEMP is set: in the workflow the script runs inside the claude-code-action step, whose
// `$GITHUB_OUTPUT` belongs to the action's own inner step, so the next step reads the file instead. The commit is authored by the git identity the checkout already has;
// when none is set it is `renovate-doctor[bot] <noreply@github.com>`. On GitHub, the token that pushes and
// opens the PR decides who the PR is from. The script exits 1 when the lift failed, after writing outputs
// whose `summary` says why.

import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGithub } from '../lib/github.mjs';
import { createGitGrep, findConditionTests, isValidIsoDate, removeExpiredRules } from '../lib/renovate_config.mjs';
import { formatOutputs } from './gate.mjs';

/** The line every lift PR body carries; a lift finds an earlier, still-open lift PR by it. */
export const liftMarker = '<!-- renovate-doctor lift -->';

const fallbackIdentity = { name: 'renovate-doctor[bot]', email: 'noreply@github.com' };

/**
 * @typedef {import('../lib/renovate_config.mjs').RemovedRule} RemovedRule
 * @typedef {import('../lib/renovate_config.mjs').MalformedMarker} MalformedMarker
 * @typedef {(file: string, args: string[], options: { cwd?: string }) => string} Exec
 * @typedef {import('../lib/github.mjs').Github} Github
 * @typedef {import('../lib/github.mjs').PullRequest} PullRequest
 * @typedef {{ required: boolean | undefined, reason?: string }} RequiredChecks
 * @typedef {{ enable: boolean, note: string, paragraph: string }} AutoMergePlan
 *
 * @typedef {{
 *   opened: boolean,
 *   prUrl: string,
 *   packages: string[],
 *   summary: string,
 *   removed: RemovedRule[],
 *   malformed: MalformedMarker[],
 *   conditionTests: string[],
 *   reused?: boolean,
 *   blocked?: boolean,
 * }} LiftResult
 *   What `lift` did; `toOutputs` turns it into the lift contract's outputs (and `lift.json`).
 *
 * @typedef {Pick<LiftResult, 'opened' | 'prUrl' | 'packages' | 'summary'> & Partial<LiftResult>} LiftOutputSource
 *   A `LiftResult`, or the shorter one `main` builds when the lift threw.
 */

/** @type {Exec} */
function defaultExec(file, args, { cwd } = {}) {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** @type {import('../lib/github.mjs').Sleep} Blocks the thread between push attempts; the script is synchronous, as gate.mjs is. */
function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** @param {unknown} text */
function oneLine(text) {
  return `${text ?? ''}`.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * @param {number} count
 * @param {string} word
 */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The packages of the removed holds, each once, in config order.
 *
 * @param {RemovedRule[]} removed
 */
export function liftedPackages(removed) {
  return [...new Set(removed.flatMap((rule) => rule.packages))];
}

/**
 * The names a removed hold goes by in the title, the summary and the PR body: its packages, or, for a rule
 * matched some other way (`matchPackagePrefixes`, `matchSourceUrls` and the like), its position in
 * `packageRules` and the start of its description, so the title never reads `()`.
 *
 * @param {RemovedRule} rule
 */
export function holdNames(rule) {
  if (rule.packages.length) return rule.packages;
  const about = rule.description.slice(0, 40).trim();
  return [`rule ${rule.index}${about ? `: ${about}` : ''}`];
}

/** @param {RemovedRule[]} removed */
function holdLabels(removed) {
  return [...new Set(removed.flatMap(holdNames))];
}

/**
 * The PR title, which is also the commit message.
 *
 * @param {RemovedRule[]} removed
 */
export function prTitle(removed) {
  return `chore(deps): lift expired Renovate holds (${holdLabels(removed).join(', ')})`;
}

/**
 * The one-line summary for the email subject; it counts holds (rules), not packages.
 *
 * @param {RemovedRule[]} removed
 * @param {{ dryRun?: boolean }} [options]
 */
export function summarize(removed, { dryRun = false } = {}) {
  const what = `${plural(removed.length, 'expired hold')}: ${holdLabels(removed).join(', ')}`;
  return dryRun ? `dry run: would lift ${what}` : `lifted ${what}`;
}

/** @param {any} error */
function httpStatus(error) {
  const status = /\(HTTP (\d{3})\)/.exec(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)?.[1];
  return status ? Number(status) : undefined;
}

/**
 * Whether `branch` requires status checks before a merge, from branch protection and, when that says
 * nothing (404, or no checks), from the rulesets that apply to the branch. `required` is undefined when
 * GitHub would not say (a token without admin rights gets 403 on branch protection), with the reason.
 *
 * @param {Pick<Github, 'ghApi'>} github
 * @param {string} repository
 * @param {string} branch
 * @returns {RequiredChecks}
 */
export function readRequiredChecks(github, repository, branch) {
  /**
   * @param {string} where
   * @param {any} error
   * @returns {RequiredChecks}
   */
  const unreadable = (where, error) => ({
    required: undefined,
    reason: `${where}: ${oneLine(error?.stderr || error?.message || error)}`,
  });
  try {
    const checks = github.ghApi(`repos/${repository}/branches/${branch}/protection/required_status_checks`);
    if ((checks?.contexts?.length ?? 0) + (checks?.checks?.length ?? 0) > 0) return { required: true };
  } catch (error) {
    if (httpStatus(error) !== 404) return unreadable('branch protection', error);
  }
  try {
    const rules = github.ghApi(`repos/${repository}/rules/branches/${branch}`) ?? [];
    const required = rules.some(
      (/** @type {{ type?: string, parameters?: any }} */ rule) =>
        rule.type === 'required_status_checks' && rule.parameters?.required_status_checks?.length > 0,
    );
    return { required };
  } catch (error) {
    if (httpStatus(error) === 404) return { required: false };
    return unreadable('rulesets', error);
  }
}

/**
 * What to do about auto-merge, given the required checks: enable it when checks are required; leave it
 * off when none are, because `gh pr merge --auto` would then merge before CI has run; enable it, with a
 * note, when the protection could not be read, since a project that adopted renovate-doctor is told to
 * require its checks. `note` goes into the summary; `paragraph` into the PR body.
 *
 * @param {RequiredChecks} checks
 * @returns {AutoMergePlan}
 */
function planAutoMerge(checks) {
  if (checks.required === true) return { enable: true, note: '', paragraph: '' };
  if (checks.required === false) {
    return {
      enable: false,
      note: 'auto-merge was not enabled because the default branch requires no checks',
      paragraph:
        'Auto-merge was not enabled: the default branch requires no status checks, so auto-merge would merge ' +
        'this PR at once, before CI has run on it. Merge it by hand once CI passes.',
    };
  }
  return {
    enable: true,
    note: `auto-merge was enabled, but the default branch's protection could not be read (${checks.reason})`,
    paragraph:
      "Auto-merge was enabled, but the default branch's required checks could not be read " +
      `(${checks.reason}); make sure CI must pass before this merges.`,
  };
}

/**
 * @param {string} summary
 * @param {string} note
 */
function withNote(summary, note) {
  return note ? `${summary}; ${note}` : summary;
}

/**
 * The lift PR's body: why it exists, a note when auto-merge is off or unverified, one
 * `- <package> (held until <date>): <description>` line per lifted package (for people; the dashboard tick
 * reads the config's history instead), the deleted condition tests, any malformed markers left alone, and
 * the lift marker.
 *
 * @param {{
 *   removed: RemovedRule[],
 *   malformed: MalformedMarker[],
 *   conditionTests: string[],
 *   configPath: string,
 *   autoMergeParagraph?: string,
 * }} input
 */
export function formatPrBody({ removed, malformed, conditionTests, configPath, autoMergeParagraph = '' }) {
  const lines = [
    `renovate-doctor removed the Renovate package rules below from \`${configPath}\` because the date in their ` +
      '`remove after` marker has passed, together with the condition tests guarding them. Once this merges, ' +
      "Renovate reopens each update on its next run; if it has not, the lift job's next run ticks the " +
      "update's checkbox on the Dependency Dashboard to recreate it. If an update still cannot be taken, " +
      'it fails CI and renovate-doctor triages it like any other.',
    ...(autoMergeParagraph ? ['', autoMergeParagraph] : []),
    '',
    'Lifted holds:',
    ...removed.flatMap((rule) =>
      holdNames(rule).map((name) => `- ${name} (held until ${rule.date}): ${rule.description}`),
    ),
  ];
  if (conditionTests.length) lines.push('', 'Deleted condition tests:', ...conditionTests.map((file) => `- ${file}`));
  if (malformed.length) {
    lines.push(
      '',
      'Not touched (malformed marker):',
      ...malformed.map((marker) => `- ${marker.description} (${marker.reason})`),
    );
  }
  lines.push('', liftMarker, '');
  return lines.join('\n');
}

/**
 * Whether a PR's head branch lives in this repository rather than in a fork.
 *
 * @param {PullRequest} pr
 * @param {string} repository
 */
function isOwnBranch(pr, repository) {
  return pr.head?.repo?.full_name === repository;
}

/**
 * @param {Github} github
 * @param {string} repository
 * @param {string} branch
 * @returns {PullRequest | undefined}
 */
function findOpenPr(github, repository, branch) {
  const owner = repository.split('/')[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  return github
    .ghApi(`repos/${repository}/pulls?head=${head}&state=open&per_page=100`)
    .find((/** @type {PullRequest} */ pr) => isOwnBranch(pr, repository));
}

// A push the remote rejected (a non-fast-forward, a protected branch) gets the same answer every time, so
// only the other failures (a stalled network, a 5xx) are retried.
/** @param {any} error */
function isRejection(error) {
  return /\[rejected\]|\[remote rejected\]|non-fast-forward|protected branch/i.test(`${error?.stderr ?? ''}`);
}

/**
 * @param {(args: string[]) => string} git
 * @param {string} branch
 * @param {{ sleep: (milliseconds: number) => void, tries?: number, pauseMs?: number }} options
 */
function pushWithRetries(git, branch, { sleep, tries = 4, pauseMs = 10_000 }) {
  for (let i = 1; ; i += 1) {
    try {
      git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
      return;
    } catch (error) {
      if (i >= tries || isRejection(error)) throw error;
      sleep(pauseMs * i);
    }
  }
}

/**
 * Removes the expired holds and opens (or, in a dry run, prints) the lift PR.
 *
 * @param {{
 *   today: string,
 *   dryRun?: boolean,
 *   repository: string,
 *   defaultBranch?: string,
 *   configPath?: string,
 *   cwd?: string,
 * }} input `defaultBranch` is looked up on GitHub when not given.
 * @param {{
 *   github: Github,
 *   exec?: Exec,
 *   fs?: {
 *     readFileSync: (file: string, encoding: 'utf8') => string,
 *     writeFileSync: (file: string, text: string) => void,
 *   },
 *   gitGrep?: (args: string[]) => string[],
 *   sleep?: (milliseconds: number) => void,
 *   out?: (text: string) => void,
 * }} deps
 * @returns {LiftResult}
 */
export function lift(
  { today, dryRun = false, repository, defaultBranch, configPath = 'renovate.json', cwd = process.cwd() },
  {
    github,
    exec = defaultExec,
    fs = nodeFs,
    gitGrep = createGitGrep(cwd),
    sleep = defaultSleep,
    out = (text) => process.stdout.write(text),
  },
) {
  if (!isValidIsoDate(today)) throw new Error(`--today must be a YYYY-MM-DD date, not ${today}`);
  if (!dryRun && (!repository || !repository.includes('/'))) {
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
  }
  const git = (/** @type {string[]} */ args) => exec('git', args, { cwd });
  const configFile = path.join(cwd, configPath);
  const heading = `renovate-doctor lift${dryRun ? ' (dry run)' : ''}`;

  const describeMalformed = (/** @type {MalformedMarker[]} */ malformed) => {
    if (!malformed.length) return;
    // A workflow-command annotation shows on the run's summary page, so a malformed marker is seen even
    // in a month when nothing expired and no email goes out.
    const descriptions = malformed.map((marker) => `${marker.description} (${marker.reason})`).join('; ');
    out(`::warning::${configPath}: ${plural(malformed.length, 'malformed hold marker')} left alone: ${descriptions}\n`);
    for (const marker of malformed) {
      out(`Not touched (malformed marker): ${marker.description} (${marker.reason})\n`);
    }
  };

  let removal = removeExpiredRules(fs.readFileSync(configFile, 'utf8'), today);
  if (!removal.removed.length) {
    out(`${heading}: nothing expired in ${configPath} on ${today}.\n`);
    describeMalformed(removal.malformed);
    return {
      opened: false,
      prUrl: '',
      packages: [],
      summary: removal.malformed.length
        ? `nothing expired; ${plural(removal.malformed.length, 'malformed marker')} left alone`
        : 'nothing expired',
      removed: [],
      malformed: removal.malformed,
      conditionTests: [],
    };
  }

  const branch = `renovate-doctor/lift-${today}`;
  /** @type {AutoMergePlan} */
  let autoMerge = { enable: true, note: '', paragraph: '' };
  const enableAutoMerge = (/** @type {string} */ url) => {
    if (!autoMerge.enable) {
      out(`Auto-merge not enabled on ${url}: the default branch requires no checks.\n`);
      return;
    }
    github.gh(['pr', 'merge', url, '--auto', '--squash']);
    out(`Enabled squash auto-merge on ${url}.${autoMerge.note ? ` Note: ${autoMerge.note}.` : ''}\n`);
  };
  if (!dryRun) {
    const base = defaultBranch || github.ghApi(`repos/${repository}`).default_branch;
    defaultBranch = base;
    /** @type {PullRequest[]} */
    const openPrs = github.ghApi(`repos/${repository}/pulls?state=open&per_page=100`, { paginate: true });
    const ownPrs = openPrs.filter((pr) => isOwnBranch(pr, repository));
    const sameBranch = ownPrs.find((pr) => pr.head.ref === branch);
    const earlier = ownPrs.find(
      (pr) =>
        pr.head.ref !== branch && pr.head.ref.startsWith('renovate-doctor/lift-') && pr.body?.includes(liftMarker),
    );
    if (!sameBranch && earlier) {
      // An earlier lift PR that has not merged still removes the holds it lifted; a second PR built from
      // the default branch would lift them again and conflict with it. A person has to look at the first.
      out(`${heading}: the previous lift PR is still open, ${earlier.html_url}; nothing lifted.\n`);
      describeMalformed(removal.malformed);
      return {
        opened: false,
        blocked: true,
        prUrl: earlier.html_url,
        packages: liftedPackages(removal.removed),
        summary: `previous lift PR still open: ${earlier.html_url}`,
        removed: removal.removed,
        malformed: removal.malformed,
        conditionTests: [],
      };
    }
    autoMerge = planAutoMerge(readRequiredChecks(github, repository, base));
    if (sameBranch) {
      // A rerun of the same day's job: the branch and PR are already there, and pushing a second commit
      // built from the default branch would be rejected, so the open PR is the result.
      out(`${heading}: ${branch} already has an open PR, ${sameBranch.html_url}; reusing it.\n`);
      enableAutoMerge(sameBranch.html_url);
      return {
        opened: true,
        prUrl: sameBranch.html_url,
        packages: liftedPackages(removal.removed),
        summary: withNote(summarize(removal.removed), autoMerge.note),
        removed: removal.removed,
        malformed: removal.malformed,
        conditionTests: [],
        reused: true,
      };
    }
    git(['switch', '-C', branch, `origin/${base}`]);
    // The config is read again on the new branch, which is the default branch's tip by construction.
    removal = removeExpiredRules(fs.readFileSync(configFile, 'utf8'), today);
    if (!removal.removed.length) throw new Error(`origin/${base}'s ${configPath} has no expired holds after all`);
  }

  const packages = liftedPackages(removal.removed);
  const conditionTests = [...new Set(packages.flatMap((name) => findConditionTests(name, { gitGrep })))]
    .filter((file) => path.normalize(file) !== path.normalize(configPath))
    .sort();
  const title = prTitle(removal.removed);
  const body = formatPrBody({
    removed: removal.removed,
    malformed: removal.malformed,
    conditionTests,
    configPath,
    autoMergeParagraph: autoMerge.paragraph,
  });

  for (const rule of removal.removed) {
    out(`Expired: ${holdNames(rule).join(', ')} (held until ${rule.date}): ${rule.description}\n`);
  }
  describeMalformed(removal.malformed);
  for (const file of conditionTests) out(`Condition test: ${file}\n`);

  try {
    if (conditionTests.length) git(['rm', '-q', '--', ...conditionTests]);
    fs.writeFileSync(configFile, removal.text);
    git(['add', '--', configPath]);
    if (dryRun) {
      out(`\n${git(['diff', 'HEAD'])}\nPR title: ${title}\n\nPR body:\n${body}`);
      out('\nDry run: nothing was committed, pushed or opened; the working tree is restored.\n');
      return {
        opened: false,
        prUrl: '',
        packages,
        summary: summarize(removal.removed, { dryRun: true }),
        removed: removal.removed,
        malformed: removal.malformed,
        conditionTests,
      };
    }
  } finally {
    // A dry run leaves the runner exactly as it found it; `git checkout HEAD --` puts back both the index
    // and the files, which `git rm` had removed from each.
    if (dryRun) git(['checkout', 'HEAD', '--', configPath, ...conditionTests]);
  }

  const identity = [];
  for (const [key, value] of Object.entries(fallbackIdentity)) {
    let current = '';
    try {
      current = git(['config', `user.${key}`]).trim();
    } catch {
      // `git config` exits 1 for a key that is not set.
    }
    if (!current) identity.push('-c', `user.${key}=${value}`);
  }
  git([...identity, 'commit', '-q', '-m', title]);
  // A branch left on the remote by an earlier run today that failed before opening its PR (there is no
  // open PR on it, or it would have been reused above) is this script's own, so it is replaced rather than
  // left to reject the push.
  if (git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]).trim()) {
    out(`${branch} is on the remote from an earlier run with no open PR; deleting it first.\n`);
    git(['push', 'origin', '--delete', branch]);
  }
  pushWithRetries(git, branch, { sleep });
  out(`Pushed ${branch}.\n`);

  /** @type {PullRequest | undefined} */
  let pr;
  try {
    pr = /** @type {PullRequest} */ (
      github.ghApi(`repos/${repository}/pulls`, {
        method: 'POST',
        body: { title, head: branch, base: defaultBranch, body },
      })
    );
  } catch (error) {
    // The create may have succeeded with its answer lost (and a retry then refused as a duplicate), so an
    // open PR on the branch is the PR this run opened.
    pr = findOpenPr(github, repository, branch);
    if (!pr) throw error;
  }
  out(`Opened ${pr.html_url}.\n`);
  try {
    enableAutoMerge(pr.html_url);
  } catch (/** @type {any} */ error) {
    // The PR exists either way; the email for the failure should link it.
    error.prUrl = pr.html_url;
    throw error;
  }
  return {
    opened: true,
    prUrl: pr.html_url,
    packages,
    summary: withNote(summarize(removal.removed), autoMerge.note),
    removed: removal.removed,
    malformed: removal.malformed,
    conditionTests,
  };
}

/**
 * The result as the `$GITHUB_OUTPUT` keys the lift contract names.
 *
 * @param {LiftOutputSource} result
 */
export function toOutputs({ opened, blocked = false, prUrl, packages, removed = [], summary }) {
  return {
    opened: opened ? 'true' : 'false',
    blocked: blocked ? 'true' : 'false',
    pr_url: prUrl,
    packages: packages.join(','),
    removed: String(removed.length),
    summary: oneLine(summary),
  };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { today: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--today') args.today = argv[(i += 1)] ?? '';
    else if (argv[i].startsWith('--today=')) args.today = argv[i].slice('--today='.length);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/**
 * Runs the lift from the command line and the environment, prints what it did, writes the outputs and
 * returns the exit code: 1 when the lift failed, otherwise 0.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   github?: Github,
 *   exec?: Exec,
 *   fs?: typeof nodeFs,
 *   gitGrep?: (args: string[]) => string[],
 *   cwd?: string,
 *   now?: Date,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 * }} [options]
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  github = createGithub(),
  exec,
  fs = nodeFs,
  gitGrep,
  cwd = process.cwd(),
  now = new Date(),
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  /** @type {LiftOutputSource} */
  let result;
  let exitCode = 0;
  try {
    const args = parseArgs(argv);
    result = lift(
      {
        today: args.today || now.toISOString().slice(0, 10),
        dryRun: args.dryRun,
        repository: env.GITHUB_REPOSITORY ?? '',
        configPath: env.RENOVATE_CONFIG || 'renovate.json',
        cwd,
      },
      { github, exec, fs, gitGrep, out },
    );
  } catch (/** @type {any} */ error) {
    err(`renovate-doctor lift error:\n${error?.stack ?? error}\n`);
    const reason = oneLine(error?.stderr || error?.message || error);
    // A PR opened before the failure (auto-merge refused, say) is still reported, so the email links it.
    const prUrl = error?.prUrl ?? '';
    result = { opened: Boolean(prUrl), prUrl, packages: [], summary: `lift failed: ${reason}` };
    exitCode = 1;
  }

  const outputs = formatOutputs(toOutputs(result));
  try {
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputs);
    else out(`GITHUB_OUTPUT is not set; the outputs would be:\n${outputs}`);
  } catch (/** @type {any} */ error) {
    err(`renovate-doctor lift could not write $GITHUB_OUTPUT:\n${error?.stack ?? error}\n`);
    exitCode = 1;
  }
  if (env.RUNNER_TEMP) {
    // The workflow's next step reads this file, not `$GITHUB_OUTPUT` (see the header); a file it cannot
    // read is reported as a failed lift, so a failed write fails the script too.
    const resultFile = path.join(env.RUNNER_TEMP, 'renovate-doctor', 'lift.json');
    try {
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, `${JSON.stringify({ ...toOutputs(result), exit_code: exitCode }, null, 2)}\n`);
    } catch (/** @type {any} */ error) {
      err(`renovate-doctor lift could not write ${resultFile}:\n${error?.stack ?? error}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] && nodeFs.realpathSync(fileURLToPath(import.meta.url)) === nodeFs.realpathSync(process.argv[1]);

if (invokedDirectly) process.exitCode = main();
