// dashboard-recreate - tick "recreate" on the Dependency Dashboard for holds lifted earlier that Renovate
// has not reopened.
//
// The lift job's first step, run before `lift.mjs`. Removing a hold does not always bring its update back:
// when Renovate's PR for that version was closed by hand, Renovate keeps ignoring the version until someone
// asks for it on the Dependency Dashboard. A hold is lifted in one of two ways - a lift PR removes an
// expired dated hold, or the agent removes a hold (and its condition test) in the fix commit of the
// Renovate PR the condition test fired on - and both show in the Renovate config's git history, so that
// history is the source: a package with a disabled rule (`"enabled": false`) in the config before a
// commit on the default branch in the last 60 days and none after it was lifted by that commit, unless it
// is held again today. For each lifted package this script checks whether Renovate has an open PR for it;
// when not, it ticks every unchecked Dependency Dashboard line naming the package (the "recreate", "other
// branch" or "pending" checkbox), and Renovate acts on the ticks on its next run. A ticked line is left
// alone, so a second run changes nothing: the script is idempotent. A dry run prints what it would tick and
// saves nothing.
//
// Usage: node scripts/dashboard-recreate.mjs [--days N] [--dry-run]
//
// Run it in a checkout of the default branch with enough history to reach back over the window
// (`fetch-depth: 0`); a shallow clone shows no commits to read.
//
// Environment: GITHUB_REPOSITORY, GH_TOKEN (read by `gh`), GITHUB_OUTPUT, RENOVATE_CONFIG (the config's
// path in the checkout, default `renovate.json`).
//
// Output (`$GITHUB_OUTPUT`): `ticked`, the comma-separated packages whose lines were ticked (or, in a dry
// run, would have been). The script exits 1 when it could not finish; nothing it does is worth failing
// the lift over, so the workflow may run it with `continue-on-error`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createGithub } from '../lib/github.mjs';
import { rulePackages } from '../lib/renovate_config.mjs';
import { formatOutputs } from './gate.mjs';

const renovateBot = 'renovate[bot]';
const dashboardTitle = 'Dependency Dashboard';

/** @typedef {(file: string, args: string[], options: { cwd?: string }) => string} Exec */

/** @type {Exec} */
function defaultExec(file, args, { cwd } = {}) {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The name Renovate uses for a package in its branch names: `@vite-pwa/assets-generator` becomes
 * `vite-pwa-assets-generator`.
 */
export function slugify(packageName) {
  return packageName
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[/\s]+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Whether `text` (a PR title, a branch name, or a dashboard line holding both) names the package: the
 * name standing on its own, or its slug as the topic of a Renovate branch (`renovate/<slug>-2.x`,
 * `renovate/major-<slug>-monorepo`). Both are bounded so that `react` does not match `react-dom` and
 * `vitest` does not match `@vitest/coverage-v8`.
 *
 * @param {string} text
 * @param {string} packageName
 */
export function namesPackage(text, packageName) {
  const name = new RegExp(`(?:^|[^\\w@/.-])${escapeRegExp(packageName)}(?:$|[^\\w/.-])`);
  const branch = new RegExp(
    `(?:^|/)(?:major-)?${escapeRegExp(slugify(packageName))}(?:-v?\\d|-monorepo|-digest|-lockfile|\\s|$)`,
  );
  return name.test(text) || branch.test(text);
}

/** The packages a config holds: those named by a rule with `"enabled": false`. */
export function heldPackages(config) {
  const rules = Array.isArray(config?.packageRules) ? config.packageRules : [];
  return new Set(rules.filter((rule) => rule?.enabled === false).flatMap((rule) => rulePackages(rule)));
}

/**
 * Reads the config as it was at `revision`: `{}` when the file (or the revision, for a root commit's
 * parent) does not exist, undefined when the file is not valid JSON.
 */
function configAt(git, revision, configPath) {
  let text;
  try {
    text = git(['show', `${revision}:${configPath}`]);
  } catch {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The packages whose hold was lifted by a commit on the checked-out branch in the last `days` days, each
 * once, with the newest commit that lifted it, leaving out packages the config holds again today. Only the
 * branch's own commits are read (`--first-parent`), so a merged branch counts as the one change it made.
 * A commit whose config, before or after, is not valid JSON is passed over: comparing against an
 * unreadable file would count every hold as lifted.
 *
 * @param {{ days: number, configPath: string, cwd?: string }} input
 * @param {{ exec?: Exec }} [deps]
 * @returns {{ name: string, commit: string }[]}
 */
export function findLiftedPackages({ days, configPath, cwd }, { exec = defaultExec } = {}) {
  const git = (args) => exec('git', args, { cwd });
  const commits = git(['log', '--first-parent', `--since=${days}.days`, '--format=%H', '--', configPath])
    .split('\n')
    .filter(Boolean);
  const heldNow = heldPackages(configAt(git, 'HEAD', configPath) ?? {});
  /** @type {Map<string, string>} */
  const lifted = new Map();
  for (const commit of commits) {
    const before = configAt(git, `${commit}^`, configPath);
    const after = configAt(git, commit, configPath);
    if (before === undefined || after === undefined) continue;
    const heldAfter = heldPackages(after);
    for (const name of heldPackages(before)) {
      if (!heldAfter.has(name) && !heldNow.has(name) && !lifted.has(name)) lifted.set(name, commit);
    }
  }
  return [...lifted].map(([name, commit]) => ({ name, commit }));
}

/**
 * Ticks every unchecked checkbox line naming one of the packages. Lines already ticked, and lines naming
 * none of them, are returned as they were.
 *
 * @param {string} body
 * @param {string[]} packages
 * @returns {{ body: string, ticked: { name: string, line: string }[] }}
 */
export function tickLines(body, packages) {
  const ticked = [];
  const lines = body.split('\n').map((line) => {
    const unchecked = /^(\s*[-*] )\[ \](.*)$/.exec(line);
    if (!unchecked) return line;
    const named = packages.filter((name) => namesPackage(unchecked[2], name));
    if (!named.length) return line;
    for (const name of named) ticked.push({ name, line: line.trim() });
    return `${unchecked[1]}[x]${unchecked[2]}`;
  });
  return { body: lines.join('\n'), ticked };
}

/**
 * Ticks the Dependency Dashboard for every lifted package that Renovate has no open PR for.
 *
 * @param {{ repository: string, days?: number, dryRun?: boolean, configPath?: string, cwd?: string }} input
 * @param {{ github: { ghApi: Function }, exec?: Exec, out?: (text: string) => void }} deps
 * @returns {{ ticked: string[], lifted: string[], open: string[], dashboardUrl: string }}
 */
export function recreate(
  { repository, days = 60, dryRun = false, configPath = 'renovate.json', cwd = process.cwd() },
  { github, exec, out = (text) => process.stdout.write(text) },
) {
  if (!repository || !repository.includes('/')) throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
  const heading = `renovate-doctor dashboard-recreate${dryRun ? ' (dry run)' : ''}`;
  const result = { ticked: /** @type {string[]} */ ([]), lifted: [], open: [], dashboardUrl: '' };

  const lifted = findLiftedPackages({ days, configPath, cwd }, { exec });
  result.lifted = lifted.map((entry) => entry.name);
  if (!lifted.length) {
    out(`${heading}: no hold was lifted from ${configPath} in the last ${days} days; nothing to recreate.\n`);
    return result;
  }

  const renovatePulls = github
    .ghApi(`repos/${repository}/pulls?state=open&per_page=100`, { paginate: true })
    .filter((pull) => pull.user?.login === renovateBot);
  const missing = [];
  for (const { name, commit } of lifted) {
    const by = `lifted in ${commit.slice(0, 7)}`;
    const reopened = renovatePulls.find((pull) => namesPackage(pull.title, name) || namesPackage(pull.head.ref, name));
    if (reopened) {
      result.open.push(name);
      out(`${name} (${by}): Renovate has reopened it as ${reopened.html_url}.\n`);
    } else {
      missing.push(name);
      out(`${name} (${by}): no open Renovate PR.\n`);
    }
  }
  if (!missing.length) return result;

  const dashboard = github
    .ghApi(`repos/${repository}/issues?creator=${encodeURIComponent(renovateBot)}&state=open&per_page=100`, {
      paginate: true,
    })
    .find((issue) => issue.title === dashboardTitle && !issue.pull_request);
  if (!dashboard) {
    out(`${heading}: no open "${dashboardTitle}" issue by ${renovateBot}; nothing ticked.\n`);
    return result;
  }
  result.dashboardUrl = dashboard.html_url;

  const { body, ticked } = tickLines(dashboard.body ?? '', missing);
  if (!ticked.length) {
    out(`${heading}: no unchecked line on ${dashboard.html_url} names ${missing.join(', ')}; nothing ticked.\n`);
    return result;
  }
  for (const { name, line } of ticked) out(`${dryRun ? 'Would tick' : 'Ticking'} for ${name}: ${line}\n`);
  result.ticked = [...new Set(ticked.map((entry) => entry.name))];
  if (dryRun) {
    out(`Dry run: ${dashboard.html_url} was not changed.\n`);
    return result;
  }
  github.ghApi(`repos/${repository}/issues/${dashboard.number}`, { method: 'PATCH', body: { body } });
  out(`Saved ${dashboard.html_url}.\n`);
  return result;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { days: 60, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    let days;
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--days') days = argv[(i += 1)];
    else if (argv[i].startsWith('--days=')) days = argv[i].slice('--days='.length);
    else throw new Error(`unknown argument: ${argv[i]}`);
    if (days === undefined) continue;
    if (!/^\d+$/.test(days)) throw new Error(`--days must be a whole number, not ${days}`);
    args.days = Number(days);
  }
  return args;
}

/**
 * Runs the script from the command line and the environment, writes the output and returns the exit
 * code: 1 when it could not finish, otherwise 0.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   github?: { ghApi: Function },
 *   exec?: Exec,
 *   cwd?: string,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 * }} [options]
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  github = createGithub(),
  exec,
  cwd = process.cwd(),
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  let ticked = [];
  let exitCode = 0;
  try {
    const args = parseArgs(argv);
    const configPath = env.RENOVATE_CONFIG || 'renovate.json';
    ({ ticked } = recreate(
      { repository: env.GITHUB_REPOSITORY ?? '', ...args, configPath, cwd },
      { github, exec, out },
    ));
  } catch (error) {
    err(`renovate-doctor dashboard-recreate error:\n${error?.stack ?? error}\n`);
    exitCode = 1;
  }

  const outputs = formatOutputs({ ticked: ticked.join(',') });
  try {
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputs);
    else out(`GITHUB_OUTPUT is not set; the outputs would be:\n${outputs}`);
  } catch (error) {
    err(`renovate-doctor dashboard-recreate could not write $GITHUB_OUTPUT:\n${error?.stack ?? error}\n`);
    exitCode = 1;
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);

if (invokedDirectly) process.exitCode = main();
