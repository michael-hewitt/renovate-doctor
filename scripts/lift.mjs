// lift - remove the Renovate holds whose date has come, with their condition tests, in one auto-merged PR.
//
// The lift job's main step, run monthly from the caller's default-branch checkout. A dated hold is a
// disabled package rule whose description carries `remove after YYYY-MM-DD: <why>`; when that date is
// today or earlier the hold has expired. This script removes every expired hold from the config, deletes
// the condition tests guarding them (tracked files that name the package and read the Renovate config),
// commits that on `renovate-doctor/lift-<today>`, pushes, opens a PR carrying `<!-- renovate-doctor lift -->`
// and enables squash auto-merge, so a dated retry never waits on a person. When the branch already has an
// open PR (a rerun of the same day's job), that PR is reused rather than opened again. A dry run makes the
// same edits in the working tree, prints the diff and the PR body, and then puts the files back; it
// touches nothing on GitHub.
//
// Usage: node scripts/lift.mjs [--today YYYY-MM-DD] [--dry-run]
//
// Environment: GITHUB_REPOSITORY, GH_TOKEN (read by `gh`), GITHUB_OUTPUT, RENOVATE_CONFIG (the config's
// path in the checkout, default `renovate.json`). The push uses the checkout's own credentials.
//
// Outputs (`$GITHUB_OUTPUT`): `opened` (`true`/`false`), `pr_url`, `packages` (comma-separated), `summary`
// (one line, for the email subject). The commit is authored by the git identity the checkout already has;
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

/** The line every lift PR body carries; `dashboard-recreate.mjs` finds merged lift PRs by it. */
export const liftMarker = '<!-- renovate-doctor lift -->';

const fallbackIdentity = { name: 'renovate-doctor[bot]', email: 'noreply@github.com' };

/**
 * @typedef {import('../lib/renovate_config.mjs').RemovedRule} RemovedRule
 * @typedef {import('../lib/renovate_config.mjs').MalformedMarker} MalformedMarker
 * @typedef {(file: string, args: string[], options: { cwd?: string }) => string} Exec
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
 * }} LiftResult
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

/** Blocks the thread between push attempts; the script is synchronous on purpose, as gate.mjs is. */
function defaultSleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function oneLine(text) {
  return `${text ?? ''}`.replace(/\s*\n\s*/g, ' ').trim();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The packages of the removed holds, each once, in config order. */
export function liftedPackages(removed) {
  return [...new Set(removed.flatMap((rule) => rule.packages))];
}

/** The PR title, which is also the commit message. */
export function prTitle(packages) {
  return `chore(deps): lift expired Renovate holds (${packages.join(', ')})`;
}

/** The one-line summary for the email subject. */
export function summarize(packages, { dryRun = false } = {}) {
  const what = `${plural(packages.length, 'expired hold')}: ${packages.join(', ')}`;
  return dryRun ? `dry run: would lift ${what}` : `lifted ${what}`;
}

/**
 * The lift PR's body: why it exists, one `- <package> (held until <date>): <description>` line per lifted
 * package (the form `dashboard-recreate.mjs` reads back), the deleted condition tests, any malformed
 * markers left alone, and the lift marker.
 *
 * @param {{ removed: RemovedRule[], malformed: MalformedMarker[], conditionTests: string[], configPath: string }} input
 */
export function formatPrBody({ removed, malformed, conditionTests, configPath }) {
  const lines = [
    `renovate-doctor removed the Renovate package rules below from \`${configPath}\` because the date in their ` +
      '`remove after` marker has passed, together with the condition tests guarding them. Once this merges, ' +
      "Renovate reopens each update on its next run; if it has not, the lift job's next run ticks the " +
      "update's checkbox on the Dependency Dashboard to recreate it. If an update still cannot be taken, " +
      'it fails CI and renovate-doctor triages it like any other.',
    '',
    'Lifted holds:',
    ...removed.flatMap((rule) =>
      rule.packages.map((name) => `- ${name} (held until ${rule.date}): ${rule.description}`),
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

function findOpenPr(github, repository, branch) {
  const owner = repository.split('/')[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  const [pr] = github.ghApi(`repos/${repository}/pulls?head=${head}&state=open&per_page=100`);
  return pr;
}

// A push the remote rejected (a non-fast-forward, a protected branch) gets the same answer every time, so
// only the other failures (a stalled network, a 5xx) are retried.
function isRejection(error) {
  return /\[rejected\]|\[remote rejected\]|non-fast-forward|protected branch/i.test(`${error?.stderr ?? ''}`);
}

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
 *   github: { ghApi: Function, gh: Function },
 *   exec?: Exec,
 *   fs?: { readFileSync: Function, writeFileSync: Function },
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
  const git = (args) => exec('git', args, { cwd });
  const configFile = path.join(cwd, configPath);
  const heading = `renovate-doctor lift${dryRun ? ' (dry run)' : ''}`;

  const describeMalformed = (malformed) => {
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
  if (!dryRun) {
    const existing = findOpenPr(github, repository, branch);
    if (existing) {
      // A rerun of the same day's job: the branch and PR are already there, and pushing a second commit
      // built from the default branch would be rejected, so the open PR is the result.
      out(`${heading}: ${branch} already has an open PR, ${existing.html_url}; reusing it.\n`);
      github.gh(['pr', 'merge', existing.html_url, '--auto', '--squash']);
      const packages = liftedPackages(removal.removed);
      return {
        opened: true,
        prUrl: existing.html_url,
        packages,
        summary: summarize(packages),
        removed: removal.removed,
        malformed: removal.malformed,
        conditionTests: [],
        reused: true,
      };
    }
    const base = defaultBranch || github.ghApi(`repos/${repository}`).default_branch;
    git(['switch', '-C', branch, `origin/${base}`]);
    // The config is read again on the new branch, which is the default branch's tip by construction.
    removal = removeExpiredRules(fs.readFileSync(configFile, 'utf8'), today);
    if (!removal.removed.length) throw new Error(`origin/${base}'s ${configPath} has no expired holds after all`);
    defaultBranch = base;
  }

  const packages = liftedPackages(removal.removed);
  const conditionTests = [...new Set(packages.flatMap((name) => findConditionTests(name, { gitGrep })))]
    .filter((file) => path.normalize(file) !== path.normalize(configPath))
    .sort();
  const title = prTitle(packages);
  const body = formatPrBody({ removed: removal.removed, malformed: removal.malformed, conditionTests, configPath });

  for (const rule of removal.removed) {
    out(`Expired: ${rule.packages.join(', ')} (held until ${rule.date}): ${rule.description}\n`);
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
        summary: summarize(packages, { dryRun: true }),
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
  pushWithRetries(git, branch, { sleep });
  out(`Pushed ${branch}.\n`);

  let pr;
  try {
    pr = github.ghApi(`repos/${repository}/pulls`, {
      method: 'POST',
      body: { title, head: branch, base: defaultBranch, body },
    });
  } catch (error) {
    // The create may have succeeded with its answer lost (and a retry then refused as a duplicate), so an
    // open PR on the branch is the PR this run opened.
    pr = findOpenPr(github, repository, branch);
    if (!pr) throw error;
  }
  out(`Opened ${pr.html_url}.\n`);
  try {
    github.gh(['pr', 'merge', pr.html_url, '--auto', '--squash']);
  } catch (error) {
    // The PR exists either way; the email for the failure should link it.
    error.prUrl = pr.html_url;
    throw error;
  }
  out('Enabled squash auto-merge.\n');
  return {
    opened: true,
    prUrl: pr.html_url,
    packages,
    summary: summarize(packages),
    removed: removal.removed,
    malformed: removal.malformed,
    conditionTests,
  };
}

/** The result as the `$GITHUB_OUTPUT` keys the lift contract names. */
export function toOutputs({ opened, prUrl, packages, summary }) {
  return { opened: opened ? 'true' : 'false', pr_url: prUrl, packages: packages.join(','), summary: oneLine(summary) };
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
 *   github?: { ghApi: Function, gh: Function },
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
  } catch (error) {
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
  } catch (error) {
    err(`renovate-doctor lift could not write $GITHUB_OUTPUT:\n${error?.stack ?? error}\n`);
    exitCode = 1;
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] && nodeFs.realpathSync(fileURLToPath(import.meta.url)) === nodeFs.realpathSync(process.argv[1]);

if (invokedDirectly) process.exitCode = main();
