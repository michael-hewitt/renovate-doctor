import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  main,
  namesPackage,
  packagesInLiftBody,
  recreate,
  slugify,
  tickLines,
} from '../scripts/dashboard-recreate.mjs';
import { formatPrBody } from '../scripts/lift.mjs';

// The dashboard is crescendosw/webapp's real Dependency Dashboard issue (#1460), trimmed before its
// "Detected Dependencies" section; the open Renovate PR is its real #3886, which is named in the dashboard's
// "Open" section. The lift PR bodies come from lift.mjs's own formatter, so the two scripts agree on them.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const dashboard = JSON.parse(fs.readFileSync(path.join(fixtures, 'dependency_dashboard_issue.json'), 'utf8'));

const repository = 'crescendosw/webapp';
const now = new Date('2026-10-12T06:00:00Z');
const routes = {
  closed: (page) => `repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
  open: `repos/${repository}/pulls?state=open&per_page=100`,
  issues: `repos/${repository}/issues?creator=renovate%5Bbot%5D&state=open&per_page=100`,
  dashboard: `repos/${repository}/issues/1460`,
};

const generatorPr = {
  number: 3886,
  title: 'chore(deps): update dependency @vite-pwa/assets-generator to v2',
  html_url: 'https://github.com/crescendosw/webapp/pull/3886',
  state: 'open',
  user: { login: 'renovate[bot]' },
  head: { ref: 'renovate/vite-pwa-assets-generator-2.x' },
};

function liftPr(number, packages, mergedAt) {
  return {
    number,
    html_url: `https://github.com/crescendosw/webapp/pull/${number}`,
    merged_at: mergedAt,
    updated_at: mergedAt,
    body: formatPrBody({
      removed: [{ packages, date: '2026-09-30', description: 'blocked upstream. remove after 2026-09-30: retry' }],
      malformed: [],
      conditionTests: [],
      configPath: 'renovate.json',
    }),
  };
}

// Lifted on 2026-10-01: the generator (Renovate has reopened it) and typescript (its PR was closed by
// hand, so it sits under "PR Closed (Blocked)"). An older lift and an unmerged one name eslint, which
// must not be picked up.
const closedPulls = [
  liftPr(3890, ['@vite-pwa/assets-generator', 'typescript'], '2026-10-01T09:00:00Z'),
  { ...liftPr(3889, ['eslint'], null), updated_at: '2026-09-30T09:00:00Z' },
  {
    number: 3870,
    html_url: 'https://github.com/crescendosw/webapp/pull/3870',
    merged_at: '2026-09-20T09:00:00Z',
    updated_at: '2026-09-20T09:00:00Z',
    body: 'Not a lift.',
  },
  liftPr(3700, ['eslint'], '2026-07-01T09:00:00Z'),
];

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

function githubWith({ open = [generatorPr], issues = [dashboard], closed = closedPulls } = {}) {
  return fakeGithub({ [routes.closed(1)]: closed, [routes.open]: open, [routes.issues]: issues });
}

const patches = (github) => github.calls.filter((call) => call.method === 'PATCH');

describe('recreate', () => {
  it('ticks the lifted package without an open Renovate PR, and not the one Renovate reopened', () => {
    const github = githubWith();
    const lines = [];
    const result = recreate({ repository, now }, { github, out: (line) => lines.push(line) });

    expect(result).toMatchObject({
      lifted: ['@vite-pwa/assets-generator', 'typescript'],
      open: ['@vite-pwa/assets-generator'],
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
    expect(lines.join('')).toContain(
      'Ticking for typescript: - [ ] <!-- recreate-branch=renovate/typescript-7.x -->[fix(deps): update dependency typescript to v7](../pull/3237)',
    );
  });

  it('counts an open Renovate PR whose branch names the package by its slug', () => {
    const renamed = { ...generatorPr, title: 'chore(deps): update pwa assets to v2' };
    const github = githubWith({ open: [renamed] });
    expect(recreate({ repository, now }, { github, out: () => {} }).open).toEqual(['@vite-pwa/assets-generator']);
  });

  it('ticks a dashboard line that names the package only by its branch slug', () => {
    const closedGenerator = { ...dashboard, body: dashboard.body.replace('rebase-branch=', 'recreate-branch=') };
    const body = closedGenerator.body.replace(
      '[chore(deps): update dependency @vite-pwa/assets-generator to v2](../pull/3886)',
      '[chore(deps): update pwa assets to v2](../pull/3886)',
    );
    const github = githubWith({ open: [], issues: [{ ...dashboard, body }] });
    const result = recreate({ repository, now }, { github, out: () => {} });
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
    expect(recreate({ repository, now }, { github, out: (line) => lines.push(line) }).ticked).toEqual([]);
    expect(patches(github)).toEqual([]);
    expect(lines.join('')).toContain('no unchecked line');
  });

  it('prints what it would tick in a dry run and saves nothing', () => {
    const github = githubWith();
    const lines = [];
    const result = recreate({ repository, now, dryRun: true }, { github, out: (line) => lines.push(line) });
    expect(result.ticked).toEqual(['typescript']);
    expect(patches(github)).toEqual([]);
    expect(lines.join('')).toContain('Would tick for typescript:');
  });

  it('says so and ticks nothing when there is no Dependency Dashboard issue', () => {
    const github = githubWith({ issues: [{ ...dashboard, title: 'Something else' }] });
    const lines = [];
    expect(recreate({ repository, now }, { github, out: (line) => lines.push(line) }).ticked).toEqual([]);
    expect(patches(github)).toEqual([]);
    expect(lines.join('')).toContain('no open "Dependency Dashboard" issue by renovate[bot]; nothing ticked.');
  });

  it('looks no further than the window, and reads nothing else when no lift PR is in it', () => {
    const github = githubWith();
    const lines = [];
    const result = recreate({ repository, now, days: 5 }, { github, out: (line) => lines.push(line) });
    expect(result.lifted).toEqual([]);
    expect(github.calls.map((call) => call.route)).toEqual([routes.closed(1)]);
    expect(lines.join('')).toContain('no lift PR merged in the last 5 days');
  });

  it('reads further pages while they reach into the window', () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      number: 4000 + i,
      merged_at: null,
      updated_at: '2026-10-11T09:00:00Z',
      body: '',
    }));
    const github = fakeGithub({
      [routes.closed(1)]: fullPage,
      [routes.closed(2)]: closedPulls,
      [routes.open]: [],
      [routes.issues]: [dashboard],
    });
    expect(recreate({ repository, now }, { github, out: () => {} }).lifted).toEqual([
      '@vite-pwa/assets-generator',
      'typescript',
    ]);
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

describe('packagesInLiftBody and tickLines', () => {
  it('reads back the packages the lift PR body lists', () => {
    expect(packagesInLiftBody(closedPulls[0].body)).toEqual(['@vite-pwa/assets-generator', 'typescript']);
  });

  it('ticks only unchecked lines', () => {
    const { body, ticked } = tickLines(' - [ ] a foo\n - [x] b foo\n - [ ] c bar\n', ['foo']);
    expect(body).toBe(' - [x] a foo\n - [x] b foo\n - [ ] c bar\n');
    expect(ticked).toEqual([{ name: 'foo', line: '- [ ] a foo' }]);
  });
});

describe('main', () => {
  it('writes the ticked packages to $GITHUB_OUTPUT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-recreate-'));
    const outputFile = path.join(dir, 'github_output');
    const code = main({
      argv: ['--days', '60', '--dry-run'],
      env: { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: outputFile },
      github: githubWith(),
      now,
      out: () => {},
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(outputFile, 'utf8')).toBe('ticked=typescript\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 on a bad --days', () => {
    const errors = [];
    const code = main({
      argv: ['--days', 'soon'],
      env: { GITHUB_REPOSITORY: repository },
      github: githubWith(),
      now,
      out: () => {},
      err: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join('')).toContain('--days must be a whole number, not soon');
  });
});
