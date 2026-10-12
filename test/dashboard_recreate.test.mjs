import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  findLiftedPackages,
  main,
  namesPackage,
  recreate,
  slugify,
  tickLines,
} from '../scripts/dashboard-recreate.mjs';

// The dashboard is crescendosw/webapp's real Dependency Dashboard issue (#1460), trimmed before its
// "Detected Dependencies" section; the open Renovate PR is its real #3886, which is named in the dashboard's
// "Open" section. The lifted holds come from a real git repository whose history covers both ways a hold
// is lifted (a lift PR's commit, and the fix commit of a Renovate PR a condition test fired on) and the
// commits that must not count.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const dashboard = JSON.parse(fs.readFileSync(path.join(fixtures, 'dependency_dashboard_issue.json'), 'utf8'));
const holdTest = fs.readFileSync(path.join(fixtures, 'pwa_assets_generator_hold.test.ts.txt'), 'utf8');

const repository = 'crescendosw/webapp';
const routes = {
  pulls: (page) => `repos/${repository}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
  issues: `repos/${repository}/issues?creator=renovate%5Bbot%5D&state=open&per_page=100`,
  dashboard: `repos/${repository}/issues/1460`,
};

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// Renovate reopened the generator's update 10 days ago, after its hold was lifted 15 days ago.
const generatorPr = {
  number: 3886,
  created_at: daysAgo(10),
  merged_at: null,
  title: 'chore(deps): update dependency @vite-pwa/assets-generator to v2',
  html_url: 'https://github.com/crescendosw/webapp/pull/3886',
  state: 'open',
  user: { login: 'renovate[bot]' },
  head: { ref: 'renovate/vite-pwa-assets-generator-2.x' },
};

const holdTestPath = 'client/src/util/test/pwa_assets_generator_hold.test.ts';
const rules = {
  generator: {
    description: 'vite-plugin-pwa only accepts the generator at v1 as a peer; see the condition test.',
    matchPackageNames: ['@vite-pwa/assets-generator'],
    matchUpdateTypes: ['major'],
    enabled: false,
  },
  typescript: {
    description: 'typescript 7 needs tsgo. remove after 2026-09-30: try tsgo on the client',
    matchPackageNames: ['typescript'],
    enabled: false,
  },
  eslint: {
    description: 'eslint 10 breaks eslint-plugin-react. remove after 2026-12-01: check its peer range',
    matchPackageNames: ['eslint'],
    enabled: false,
  },
  pdfjs: { matchPackagePatterns: ['pdfjs-dist'], enabled: false },
  oldPkg: { description: 'remove after 2026-06-01: retry', matchPackageNames: ['old-pkg'], enabled: false },
  leftPad: { description: 'remove after 2026-10-05: retry', matchPackageNames: ['left-pad'], enabled: false },
};
const config = (...packageRules) => `${JSON.stringify({ extends: ['config:recommended'], packageRules }, null, 2)}\n`;

const roots = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Builds a repository from `steps`, oldest first: each writes files (a null content deletes the file) and
 * is committed `daysAgo` days before now. Returns the repository and the commit of each step.
 */
function makeHistory(steps) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-recreate-'));
  roots.push(repo);
  const git = (args, env = {}) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  git(['init', '-q', '-b', 'main']);
  const commits = [];
  for (const { daysAgo, files, message } of steps) {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(repo, file);
      if (content === null) {
        fs.rmSync(full);
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    git(['add', '-A']);
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    git(['-c', 'user.name=M', '-c', 'user.email=m@example.com', 'commit', '-q', '-m', message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    commits.push(git(['rev-parse', 'HEAD']));
  }
  return { repo, commits };
}

const { repo, commits } = makeHistory([
  {
    daysAgo: 100,
    message: 'chore: hold the updates that cannot be taken yet',
    files: {
      'renovate.json': config(rules.generator, rules.typescript, rules.eslint, rules.pdfjs, rules.oldPkg),
      [holdTestPath]: holdTest,
      'package.json': '{ "devDependencies": { "vite-plugin-pwa": "1.2.0" } }\n',
    },
  },
  // Lifted, but before the 60-day window.
  {
    daysAgo: 90,
    message: 'chore(deps): lift expired Renovate holds (old-pkg)',
    files: { 'renovate.json': config(rules.generator, rules.typescript, rules.eslint, rules.pdfjs) },
  },
  // A lift PR's squash commit.
  {
    daysAgo: 20,
    message: 'chore(deps): lift expired Renovate holds (typescript) (#3890)',
    files: { 'renovate.json': config(rules.generator, rules.eslint, rules.pdfjs) },
  },
  // The agent's fix commit on the Renovate PR the condition test fired on: the rule and the test go together.
  {
    daysAgo: 15,
    message: 'fix(deps): lift the generator hold so that chore(deps): update dependency vite-plugin-pwa to v2 passes',
    files: {
      'renovate.json': config(rules.eslint, rules.pdfjs),
      [holdTestPath]: null,
      'package.json': '{ "devDependencies": { "vite-plugin-pwa": "2.0.0" } }\n',
    },
  },
  // Only a description changes: nothing is lifted.
  {
    daysAgo: 10,
    message: 'chore: say why eslint is held',
    files: { 'renovate.json': config({ ...rules.eslint, description: `${rules.eslint.description}.` }, rules.pdfjs) },
  },
  // Held and lifted inside the window: lifted once.
  {
    daysAgo: 8,
    message: 'chore: hold left-pad',
    files: {
      'renovate.json': config(
        { ...rules.eslint, description: `${rules.eslint.description}.` },
        rules.pdfjs,
        rules.leftPad,
      ),
    },
  },
  {
    daysAgo: 5,
    message: 'chore(deps): lift expired Renovate holds (left-pad)',
    files: { 'renovate.json': config({ ...rules.eslint, description: `${rules.eslint.description}.` }, rules.pdfjs) },
  },
  // A commit that does not touch the config.
  { daysAgo: 3, message: 'docs: a readme', files: { 'README.md': '# webapp\n' } },
]);

function fakeGithub(responses) {
  const calls = [];
  return {
    calls,
    ghApi(route, options = {}) {
      calls.push({ route, ...options });
      if (options.method === 'PATCH') return {};
      if (!(route in responses)) throw new Error(`unexpected route ${route}`);
      return structuredClone(responses[route]);
    },
  };
}

function githubWith({ pulls = [generatorPr], issues = [dashboard] } = {}) {
  return fakeGithub({ [routes.pulls(1)]: pulls, [routes.issues]: issues });
}

const patches = (github) => github.calls.filter((call) => call.method === 'PATCH');

describe('findLiftedPackages', () => {
  it('finds holds lifted by a lift commit and by a condition-test fix commit, newest first, each once', () => {
    const lifted = findLiftedPackages({ days: 60, configPath: 'renovate.json', cwd: repo });
    expect(lifted.map(({ name, commit }) => ({ name, commit }))).toEqual([
      { name: 'left-pad', commit: commits[6] },
      { name: '@vite-pwa/assets-generator', commit: commits[3] },
      { name: 'typescript', commit: commits[2] },
    ]);
    // The lifting commit's date, which the open-PR check compares Renovate's PRs against.
    expect(Math.abs(Date.parse(lifted[1].date) - Date.parse(daysAgo(15)))).toBeLessThan(60_000);
  });

  it('reads only the window', () => {
    expect(findLiftedPackages({ days: 6, configPath: 'renovate.json', cwd: repo }).map((entry) => entry.name)).toEqual([
      'left-pad',
    ]);
    expect(
      findLiftedPackages({ days: 120, configPath: 'renovate.json', cwd: repo }).map((entry) => entry.name),
    ).toEqual(['left-pad', '@vite-pwa/assets-generator', 'typescript', 'old-pkg']);
  });

  it('leaves out a package that is held again today, and a commit whose config is not JSON', () => {
    const history = makeHistory([
      { daysAgo: 10, message: 'hold', files: { 'renovate.json': config(rules.leftPad, rules.eslint) } },
      { daysAgo: 6, message: 'lift', files: { 'renovate.json': config(rules.eslint) } },
      { daysAgo: 4, message: 'hold again', files: { 'renovate.json': config(rules.leftPad, rules.eslint) } },
      { daysAgo: 3, message: 'break', files: { 'renovate.json': '{ not json\n' } },
      { daysAgo: 2, message: 'fix', files: { 'renovate.json': config(rules.leftPad, rules.eslint) } },
    ]);
    expect(findLiftedPackages({ days: 60, configPath: 'renovate.json', cwd: history.repo })).toEqual([]);
  });

  it('finds nothing for a config path the history does not have', () => {
    expect(findLiftedPackages({ days: 60, configPath: '.github/renovate.json', cwd: repo })).toEqual([]);
  });
});

describe('recreate', () => {
  it('ticks the lifted package Renovate opened no PR for since, and not the one Renovate reopened', () => {
    const github = githubWith();
    const lines = [];
    const result = recreate({ repository, cwd: repo }, { github, out: (line) => lines.push(line) });

    expect(result).toMatchObject({
      lifted: ['left-pad', '@vite-pwa/assets-generator', 'typescript'],
      reopened: ['@vite-pwa/assets-generator'],
      ticked: ['typescript'],
    });
    expect(patches(github)).toHaveLength(1);
    const [patch] = patches(github);
    expect(patch.route).toBe(routes.dashboard);
    expect(patch.body.body).toBe(
      dashboard.body.replace(
        ' - [ ] <!-- recreate-branch=renovate/typescript-7.x -->',
        ' - [x] <!-- recreate-branch=renovate/typescript-7.x -->',
      ),
    );
    const printed = lines.join('');
    expect(printed).toContain(
      `typescript (lifted in ${commits[2].slice(0, 7)} on ${daysAgo(20).slice(0, 10)}): Renovate has opened no PR for it since.`,
    );
    expect(printed).toContain(`${generatorPr.html_url} since (open); left alone.`);
    expect(printed).toContain(
      'Ticking for typescript: - [ ] <!-- recreate-branch=renovate/typescript-7.x -->[fix(deps): update dependency typescript to v7](../pull/3237)',
    );
  });

  it('counts a Renovate PR whose branch names the package by its slug', () => {
    const renamed = { ...generatorPr, title: 'chore(deps): update pwa assets to v2' };
    const github = githubWith({ pulls: [renamed] });
    expect(recreate({ repository, cwd: repo }, { github, out: () => {} }).reopened).toEqual([
      '@vite-pwa/assets-generator',
    ]);
  });

  it("never undoes a person's close: a Renovate PR opened since the lift and closed counts, as a merged one does", () => {
    const closed = { ...generatorPr, state: 'closed' };
    const merged = {
      ...generatorPr,
      number: 3895,
      title: 'fix(deps): update dependency typescript to v7',
      head: { ref: 'renovate/typescript-7.x' },
      state: 'closed',
      merged_at: daysAgo(2),
      created_at: daysAgo(4),
    };
    const github = githubWith({ pulls: [merged, closed] });
    const result = recreate({ repository, cwd: repo }, { github, out: () => {} });
    expect(result.reopened).toEqual(['@vite-pwa/assets-generator', 'typescript']);
    expect(result.ticked).toEqual([]);
    expect(patches(github)).toEqual([]);
  });

  it('ignores a Renovate PR from before the lift, and never ticks a line that is not a recreate line', () => {
    // The generator's PR predates its lift, so it does not count; but the generator's dashboard line is
    // the "Open" section's rebase checkbox, which is never ticked.
    const github = githubWith({ pulls: [{ ...generatorPr, created_at: daysAgo(30) }] });
    const result = recreate({ repository, cwd: repo }, { github, out: () => {} });
    expect(result.reopened).toEqual([]);
    expect(result.ticked).toEqual(['typescript']);
    expect(patches(github)[0].body.body).toContain(
      ' - [ ] <!-- rebase-branch=renovate/vite-pwa-assets-generator-2.x -->',
    );
  });

  it('reads further pages of PRs while they reach back to the oldest lift', () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ...generatorPr,
      number: 4000 + i,
      title: 'chore(deps): update dependency jsdom to v30',
      head: { ref: 'renovate/jsdom-30.x' },
      created_at: daysAgo(1),
    }));
    const github = fakeGithub({
      [routes.pulls(1)]: fullPage,
      // typescript was lifted 20 days ago, the oldest lift: its PR from 18 days ago counts; the page ends
      // with a PR older than every lift, so no third page is read.
      [routes.pulls(2)]: [
        { ...generatorPr, title: 'fix(deps): update dependency typescript to v7', created_at: daysAgo(18) },
        { ...generatorPr, created_at: daysAgo(25) },
      ],
      [routes.issues]: [dashboard],
    });
    const result = recreate({ repository, cwd: repo }, { github, out: () => {} });
    expect(result.reopened).toEqual(['typescript']);
    expect(github.calls.filter((call) => call.route.includes('state=all'))).toHaveLength(2);
  });

  it('ticks a dashboard line that names the package only by its branch slug', () => {
    const body = dashboard.body
      .replace('rebase-branch=', 'recreate-branch=')
      .replace(
        '[chore(deps): update dependency @vite-pwa/assets-generator to v2](../pull/3886)',
        '[chore(deps): update pwa assets to v2](../pull/3886)',
      );
    const github = githubWith({ pulls: [], issues: [{ ...dashboard, body }] });
    const result = recreate({ repository, cwd: repo }, { github, out: () => {} });
    expect(result.ticked).toEqual(['@vite-pwa/assets-generator', 'typescript']);
    expect(patches(github)[0].body.body).toContain(
      ' - [x] <!-- recreate-branch=renovate/vite-pwa-assets-generator-2.x -->[chore(deps): update pwa assets to v2]',
    );
  });

  it('leaves an already-ticked line alone and saves nothing', () => {
    const body = dashboard.body.replace(
      ' - [ ] <!-- recreate-branch=renovate/typescript-7.x -->',
      ' - [x] <!-- recreate-branch=renovate/typescript-7.x -->',
    );
    const github = githubWith({ issues: [{ ...dashboard, body }] });
    const lines = [];
    expect(recreate({ repository, cwd: repo }, { github, out: (line) => lines.push(line) }).ticked).toEqual([]);
    expect(patches(github)).toEqual([]);
    expect(lines.join('')).toContain('no unchecked recreate line');
  });

  it('prints what it would tick in a dry run and saves nothing', () => {
    const github = githubWith();
    const lines = [];
    const result = recreate({ repository, cwd: repo, dryRun: true }, { github, out: (line) => lines.push(line) });
    expect(result.ticked).toEqual(['typescript']);
    expect(patches(github)).toEqual([]);
    expect(lines.join('')).toContain('Would tick for typescript:');
  });

  it('says so and ticks nothing when there is no Dependency Dashboard issue', () => {
    const github = githubWith({ issues: [{ ...dashboard, title: 'Something else' }] });
    const lines = [];
    expect(recreate({ repository, cwd: repo }, { github, out: (line) => lines.push(line) }).ticked).toEqual([]);
    expect(patches(github)).toEqual([]);
    expect(lines.join('')).toContain('no open "Dependency Dashboard" issue by renovate[bot]; nothing ticked.');
  });

  it('calls nothing on GitHub when no hold was lifted in the window', () => {
    const github = githubWith();
    const lines = [];
    const result = recreate({ repository, cwd: repo, days: 4 }, { github, out: (line) => lines.push(line) });
    expect(result.lifted).toEqual([]);
    expect(github.calls).toEqual([]);
    expect(lines.join('')).toContain('no hold was lifted from renovate.json in the last 4 days');
  });
});

describe('namesPackage', () => {
  it.each([
    ['chore(deps): update dependency @vite-pwa/assets-generator to v2', '@vite-pwa/assets-generator', true],
    ['renovate/vite-pwa-assets-generator-2.x', '@vite-pwa/assets-generator', true],
    ['renovate/major-vitest-monorepo', 'vitest', true],
    ['fix(deps): update vitest monorepo to v5 (`@vitest/coverage-v8`, `vitest`)', 'vitest', true],
    ['fix(deps): update dependency @vitest/coverage-v8 to v5', 'vitest', false],
    ['chore(deps): update dependency react-dom to v20', 'react', false],
    ['renovate/react-dom-20.x', 'react', false],
    ['renovate/eslint-react-eslint-plugin-5.x', 'eslint-plugin', false],
  ])('%s names %s: %s', (text, name, expected) => {
    expect(namesPackage(text, name)).toBe(expected);
  });

  it('slugifies a scoped name as Renovate does in branch names', () => {
    expect(slugify('@vite-pwa/assets-generator')).toBe('vite-pwa-assets-generator');
  });
});

describe('tickLines', () => {
  it('ticks only unchecked recreate lines', () => {
    const lines = [
      ' - [ ] <!-- recreate-branch=renovate/foo-2.x -->[update foo to v2](../pull/1)',
      ' - [x] <!-- recreate-branch=renovate/foo-3.x -->[update foo to v3](../pull/2)',
      ' - [ ] <!-- rebase-branch=renovate/foo-1.x -->[update foo to v1.2](../pull/3)',
      ' - [ ] <!-- approve-branch=renovate/foo-4.x -->update foo to v4',
      ' - [ ] <!-- approvePr-branch=renovate/foo-5.x -->update foo to v5',
      ' - [ ] <!-- unlimit-branch=renovate/foo-6.x -->update foo to v6',
      ' - [ ] <!-- recreate-branch=renovate/bar-2.x -->[update bar to v2](../pull/7)',
    ];
    const { body, ticked } = tickLines(lines.join('\n'), ['foo']);
    expect(body).toBe([lines[0].replace('[ ]', '[x]'), ...lines.slice(1)].join('\n'));
    expect(ticked.map((entry) => entry.line)).toEqual([lines[0].trim()]);
  });
});

describe('main', () => {
  it('writes the ticked packages to $GITHUB_OUTPUT, reading the config path from RENOVATE_CONFIG', () => {
    const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-recreate-')), 'out');
    roots.push(path.dirname(outputFile));
    const code = main({
      argv: ['--days', '60', '--dry-run'],
      env: { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: outputFile, RENOVATE_CONFIG: 'renovate.json' },
      github: githubWith(),
      cwd: repo,
      out: () => {},
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(outputFile, 'utf8')).toBe('ticked=typescript\n');
  });

  it('exits 1 on a bad --days', () => {
    const errors = [];
    const code = main({
      argv: ['--days', 'soon'],
      env: { GITHUB_REPOSITORY: repository },
      github: githubWith(),
      cwd: repo,
      out: () => {},
      err: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join('')).toContain('--days must be a whole number, not soon');
  });
});
