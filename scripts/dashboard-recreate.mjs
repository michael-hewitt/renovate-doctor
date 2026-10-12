// dashboard-recreate - tick "recreate" on the Dependency Dashboard for holds lifted earlier that Renovate
// has not reopened.
//
// The lift job's first step, run before `lift.mjs`. Removing a hold does not always bring its update back:
// when Renovate's PR for that version was closed by hand, Renovate keeps ignoring the version until someone
// asks for it on the Dependency Dashboard. So for every package a lift PR merged in the last 60 days names,
// this script checks whether Renovate has an open PR for it; when not, it ticks every unchecked
// Dependency Dashboard line naming the package (the "recreate", "other branch" or "pending" checkbox), and
// Renovate acts on the ticks on its next run. A ticked line is left alone, so a second run changes nothing:
// the script is idempotent. A dry run prints what it would tick and saves nothing.
//
// Usage: node scripts/dashboard-recreate.mjs [--days N] [--dry-run]
//
// Environment: GITHUB_REPOSITORY, GH_TOKEN (read by `gh`), GITHUB_OUTPUT.
//
// Output (`$GITHUB_OUTPUT`): `ticked`, the comma-separated packages whose lines were ticked (or, in a dry
// run, would have been). The script exits 1 when it could not finish; nothing it does is worth failing
// the lift over, so the workflow may run it with `continue-on-error`.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createGithub } from '../lib/github.mjs';
import { formatOutputs } from './gate.mjs';
import { liftMarker } from './lift.mjs';

const renovateBot = 'renovate[bot]';
const dashboardTitle = 'Dependency Dashboard';
const dayMs = 24 * 60 * 60 * 1000;

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

/** The packages a lift PR's body lists, from its `- <package> (held until <date>)` lines. */
export function packagesInLiftBody(body) {
  return [...`${body ?? ''}`.matchAll(/^- (.+?) \(held until \d{4}-\d{2}-\d{2}\)/gm)].map((match) => match[1]);
}

/**
 * The packages lifted by lift PRs merged within `days` before `now`, each once, with the PR that lifted it.
 * Closed PRs are read newest-updated first, page by page, until a page reaches back past the window: a PR
 * merged inside it was updated inside it too.
 *
 * @returns {{ name: string, pr: string }[]}
 */
export function findLiftedPackages(github, repository, { days, now }) {
  const cutoff = now.getTime() - days * dayMs;
  /** @type {Map<string, string>} */
  const lifted = new Map();
  for (let page = 1; ; page += 1) {
    const pulls = github.ghApi(
      `repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    for (const pull of pulls) {
      if (!pull.merged_at || Date.parse(pull.merged_at) < cutoff || !pull.body?.includes(liftMarker)) continue;
      for (const name of packagesInLiftBody(pull.body)) if (!lifted.has(name)) lifted.set(name, pull.html_url);
    }
    if (pulls.length < 100 || Date.parse(pulls.at(-1).updated_at) < cutoff) break;
  }
  return [...lifted].map(([name, pr]) => ({ name, pr }));
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
 * @param {{ repository: string, days?: number, dryRun?: boolean, now?: Date }} input
 * @param {{ github: { ghApi: Function }, out?: (text: string) => void }} deps
 * @returns {{ ticked: string[], lifted: string[], open: string[], dashboardUrl: string }}
 */
export function recreate(
  { repository, days = 60, dryRun = false, now = new Date() },
  { github, out = (text) => process.stdout.write(text) },
) {
  if (!repository || !repository.includes('/')) throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
  const heading = `renovate-doctor dashboard-recreate${dryRun ? ' (dry run)' : ''}`;
  const result = { ticked: /** @type {string[]} */ ([]), lifted: [], open: [], dashboardUrl: '' };

  const lifted = findLiftedPackages(github, repository, { days, now });
  result.lifted = lifted.map((entry) => entry.name);
  if (!lifted.length) {
    out(`${heading}: no lift PR merged in the last ${days} days; nothing to recreate.\n`);
    return result;
  }

  const renovatePulls = github
    .ghApi(`repos/${repository}/pulls?state=open&per_page=100`, { paginate: true })
    .filter((pull) => pull.user?.login === renovateBot);
  const missing = [];
  for (const { name, pr } of lifted) {
    const reopened = renovatePulls.find((pull) => namesPackage(pull.title, name) || namesPackage(pull.head.ref, name));
    if (reopened) {
      result.open.push(name);
      out(`${name} (lifted by ${pr}): Renovate has reopened it as ${reopened.html_url}.\n`);
    } else {
      missing.push(name);
      out(`${name} (lifted by ${pr}): no open Renovate PR.\n`);
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
 *   now?: Date,
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 * }} [options]
 */
export function main({
  argv = process.argv.slice(2),
  env = process.env,
  github = createGithub(),
  now = new Date(),
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
} = {}) {
  let ticked = [];
  let exitCode = 0;
  try {
    const args = parseArgs(argv);
    ({ ticked } = recreate({ repository: env.GITHUB_REPOSITORY ?? '', ...args, now }, { github, out }));
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
