import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatPrBody, lift, liftMarker, main, parseArgs, toOutputs } from '../scripts/lift.mjs';

// The lift runs against a real git repository cloned from a bare `origin`, so its branch, commit, push and
// dry-run restore are the real thing; only GitHub is faked. renovate_holds.json has two expired holds
// (@vite-pwa/assets-generator, and typescript expiring today), a future one, a malformed one and one with
// no marker; the hold test is crescendosw/webapp's real condition test for the first.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const text = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');
const holdsConfig = text('renovate_holds.json');
const webappConfig = text('webapp_renovate.json');
const holdTest = text('pwa_assets_generator_hold.test.ts.txt');

const repository = 'crescendosw/webapp';
const today = '2026-10-12';
const branch = 'renovate-doctor/lift-2026-10-12';
const prUrl = 'https://github.com/crescendosw/webapp/pull/3901';
const openPrsRoute = `repos/${repository}/pulls?head=crescendosw%3Arenovate-doctor%2Flift-2026-10-12&state=open&per_page=100`;
const holdTestPath = 'client/src/util/test/pwa_assets_generator_hold.test.ts';

// Git with no global or system config, so the identity fallback is tested on every machine alike.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const exec = (file, args, { cwd } = {}) =>
  execFileSync(file, args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, args) => exec('git', args, { cwd });

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo(config = holdsConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-lift-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['init', '-q', '-b', 'main', work]);
  const files = {
    'renovate.json': config,
    [holdTestPath]: holdTest,
    'client/vite.config.ts': '// pwaAssets loads @vite-pwa/assets-generator at build time.\nexport default {};\n',
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(work, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  git(work, ['add', '.']);
  git(work, ['-c', 'user.name=Michael', '-c', 'user.email=michael@example.com', 'commit', '-q', '-m', 'initial']);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['push', '-q', 'origin', 'main']);
  return { origin, work };
}

/** A fake GitHub: `responses` maps a route to its answer (a function receives the call's options). */
function fakeGithub(responses = {}) {
  const calls = [];
  return {
    calls,
    ghApi(route, options = {}) {
      calls.push({ route, ...options });
      if (!(route in responses)) throw new Error(`unexpected route ${route}`);
      const answer = responses[route];
      return typeof answer === 'function' ? answer(options) : structuredClone(answer);
    },
    gh(args) {
      calls.push({ gh: args });
      return '';
    },
  };
}

function capture() {
  const lines = [];
  return { out: (line) => lines.push(line), text: () => lines.join('') };
}

const githubForNewPr = () =>
  fakeGithub({
    [openPrsRoute]: [],
    [`repos/${repository}`]: { default_branch: 'main' },
    [`repos/${repository}/pulls`]: { number: 3901, html_url: prUrl },
  });

describe('lift', () => {
  it('does nothing when nothing has expired', () => {
    const { work } = makeRepo(webappConfig);
    const github = fakeGithub();
    const output = capture();
    const result = lift({ today, repository, cwd: work }, { github, exec, out: output.out });

    expect(result).toMatchObject({ opened: false, prUrl: '', packages: [], summary: 'nothing expired' });
    expect(github.calls).toEqual([]);
    expect(output.text()).toContain('nothing expired in renovate.json on 2026-10-12');
    expect(git(work, ['branch', '--list']).trim()).toBe('* main');
    expect(toOutputs(result)).toEqual({ opened: 'false', pr_url: '', packages: '', summary: 'nothing expired' });
  });

  it('annotates the run with the malformed markers even when nothing expired', () => {
    const { work } = makeRepo();
    const output = capture();
    const result = lift(
      { today: '2026-09-29', repository, cwd: work },
      { github: fakeGithub(), exec, out: output.out },
    );
    expect(result.summary).toBe('nothing expired; 1 malformed marker left alone');
    expect(output.text()).toContain('::warning::renovate.json: 1 malformed hold marker left alone: motion 15');
  });

  it('removes the expired holds and their condition test, pushes a branch and opens an auto-merged PR', () => {
    const { origin, work } = makeRepo();
    const github = githubForNewPr();
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });

    const packages = ['@vite-pwa/assets-generator', 'typescript', '@typescript/native-preview'];
    expect(result).toMatchObject({
      opened: true,
      prUrl,
      packages,
      conditionTests: [holdTestPath],
      summary: 'lifted 3 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview',
    });
    expect(toOutputs(result)).toEqual({
      opened: 'true',
      pr_url: prUrl,
      packages: '@vite-pwa/assets-generator,typescript,@typescript/native-preview',
      summary: 'lifted 3 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview',
    });

    // The commit is on the pushed branch, from main, with the config trimmed and the hold test gone.
    const title =
      'chore(deps): lift expired Renovate holds (@vite-pwa/assets-generator, typescript, @typescript/native-preview)';
    expect(git(origin, ['log', '-1', '--format=%s%n%an <%ae>', branch]).trim()).toBe(
      `${title}\nrenovate-doctor[bot] <noreply@github.com>`,
    );
    expect(git(origin, ['rev-parse', `${branch}~1`])).toBe(git(origin, ['rev-parse', 'main']));
    expect(git(origin, ['diff', '--name-status', 'main', branch]).trim().split('\n')).toEqual([
      `D\t${holdTestPath}`,
      'M\trenovate.json',
    ]);
    const pushedConfig = JSON.parse(git(origin, ['show', `${branch}:renovate.json`]));
    expect(pushedConfig.packageRules.map((rule) => rule.matchPackageNames ?? rule.matchPackagePatterns)).toEqual([
      ['pdfjs-dist'],
      ['eslint'],
      ['motion'],
    ]);

    // The PR: its title, base, head and body, then squash auto-merge.
    const create = github.calls.find((call) => call.route === `repos/${repository}/pulls`);
    expect(create.method).toBe('POST');
    expect(create.body).toMatchObject({ title, head: branch, base: 'main' });
    expect(create.body.body).toContain(
      '\nLifted holds:\n' +
        '- @vite-pwa/assets-generator (held until 2026-09-30): vite-plugin-pwa only accepts the generator at v1 as a ' +
        "peer. remove after 2026-09-30: check whether vite-plugin-pwa's peer range accepts v2\n" +
        '- typescript (held until 2026-10-12): typescript 7 needs the native preview of the type checker. remove ' +
        'after 2026-10-12: try tsgo on the client\n' +
        '- @typescript/native-preview (held until 2026-10-12): typescript 7 needs the native preview of the type ' +
        'checker. remove after 2026-10-12: try tsgo on the client\n',
    );
    expect(create.body.body).toContain(`\nDeleted condition tests:\n- ${holdTestPath}\n`);
    expect(create.body.body).toContain(
      '\nNot touched (malformed marker):\n- motion 15 drops the layout prop we use. remove after 2026-02-30: check ' +
        'the migration guide (not a real calendar date: 2026-02-30)\n',
    );
    expect(create.body.body.trimEnd().endsWith(liftMarker)).toBe(true);
    expect(github.calls.at(-1)).toEqual({ gh: ['pr', 'merge', prUrl, '--auto', '--squash'] });
  });

  it("keeps the checkout's own git identity when one is set", () => {
    const { origin, work } = makeRepo();
    git(work, ['config', 'user.name', 'Lift Bot']);
    git(work, ['config', 'user.email', 'lift@example.com']);
    lift({ today, repository, cwd: work }, { github: githubForNewPr(), exec, out: () => {} });
    expect(git(origin, ['log', '-1', '--format=%an <%ae>', branch]).trim()).toBe('Lift Bot <lift@example.com>');
  });

  it('reuses an open PR already on the branch instead of pushing again', () => {
    const { origin, work } = makeRepo();
    const github = fakeGithub({ [openPrsRoute]: [{ number: 3899, html_url: 'https://github.com/x/y/pull/3899' }] });
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });

    expect(result).toMatchObject({ opened: true, prUrl: 'https://github.com/x/y/pull/3899', reused: true });
    expect(github.calls.map((call) => call.route ?? call.gh.join(' '))).toEqual([
      openPrsRoute,
      'pr merge https://github.com/x/y/pull/3899 --auto --squash',
    ]);
    expect(git(origin, ['branch', '--list']).trim()).toBe('* main');
    expect(git(work, ['status', '--porcelain'])).toBe('');
  });

  it('takes the PR found on the branch when creating it failed after GitHub had made it', () => {
    const { work } = makeRepo();
    let lookups = 0;
    const github = fakeGithub({
      [openPrsRoute]: () => (lookups++ === 0 ? [] : [{ number: 3901, html_url: prUrl }]),
      [`repos/${repository}`]: { default_branch: 'main' },
      [`repos/${repository}/pulls`]: () => {
        throw new Error('gh: Validation Failed: A pull request already exists (HTTP 422)');
      },
    });
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });
    expect(result).toMatchObject({ opened: true, prUrl });
    expect(github.calls.at(-1)).toEqual({ gh: ['pr', 'merge', prUrl, '--auto', '--squash'] });
  });

  it('prints the diff and the PR body in a dry run, calls nothing on GitHub and restores the tree', () => {
    const { origin, work } = makeRepo();
    const github = fakeGithub();
    const output = capture();
    const result = lift({ today, dryRun: true, repository, cwd: work }, { github, exec, out: output.out });

    expect(github.calls).toEqual([]);
    expect(result).toMatchObject({
      opened: false,
      prUrl: '',
      summary:
        'dry run: would lift 3 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview',
    });
    const printed = output.text();
    expect(printed).toContain(`diff --git a/${holdTestPath} b/${holdTestPath}\ndeleted file mode`);
    expect(printed).toContain('-      "matchPackageNames": ["@vite-pwa/assets-generator"],');
    expect(printed).toContain('PR title: chore(deps): lift expired Renovate holds (@vite-pwa/assets-generator,');
    expect(printed).toContain(liftMarker);

    expect(git(work, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(work, 'renovate.json'), 'utf8')).toBe(holdsConfig);
    expect(fs.readFileSync(path.join(work, holdTestPath), 'utf8')).toBe(holdTest);
    expect(git(work, ['branch', '--list']).trim()).toBe('* main');
    expect(git(origin, ['branch', '--list']).trim()).toBe('* main');
  });
});

describe('formatPrBody', () => {
  it('leaves out the sections that have nothing in them', () => {
    const body = formatPrBody({
      removed: [{ packages: ['left-pad'], date: '2026-01-31', description: 'remove after 2026-01-31: retry' }],
      malformed: [],
      conditionTests: [],
      configPath: 'renovate.json',
    });
    expect(body).toContain('\n\nLifted holds:\n- left-pad (held until 2026-01-31): remove after 2026-01-31: retry\n\n');
    expect(body).not.toContain('Deleted condition tests:');
    expect(body).not.toContain('Not touched');
    expect(body.endsWith(`${liftMarker}\n`)).toBe(true);
  });
});

describe('parseArgs', () => {
  it('reads --today and --dry-run', () => {
    expect(parseArgs(['--today', '2026-11-01', '--dry-run'])).toEqual({ today: '2026-11-01', dryRun: true });
    expect(parseArgs(['--today=2026-11-01'])).toEqual({ today: '2026-11-01', dryRun: false });
  });

  it('refuses an argument it does not know', () => {
    expect(() => parseArgs(['--force'])).toThrow('unknown argument: --force');
  });
});

describe('main', () => {
  it('writes the outputs, reading the config path from RENOVATE_CONFIG', () => {
    const { work } = makeRepo();
    fs.mkdirSync(path.join(work, '.github'));
    fs.renameSync(path.join(work, 'renovate.json'), path.join(work, '.github/renovate.json'));
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.name=M', '-c', 'user.email=m@example.com', 'commit', '-q', '-m', 'move']);
    const outputFile = path.join(work, '..', 'github_output');
    const code = main({
      argv: ['--today', today, '--dry-run'],
      env: { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: outputFile, RENOVATE_CONFIG: '.github/renovate.json' },
      github: fakeGithub(),
      exec,
      cwd: work,
      out: () => {},
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      'opened=false\npr_url=\npackages=@vite-pwa/assets-generator,typescript,@typescript/native-preview\n' +
        'summary=dry run: would lift 3 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview\n',
    );
    expect(git(work, ['status', '--porcelain'])).toBe('');
  });

  it('exits 1 with a summary saying why when the lift fails', () => {
    const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-lift-')), 'github_output');
    roots.push(path.dirname(outputFile));
    const errors = capture();
    const code = main({
      argv: ['--today', '2026-10-32'],
      env: { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: outputFile },
      github: fakeGithub(),
      exec,
      out: () => {},
      err: errors.out,
    });
    expect(code).toBe(1);
    expect(fs.readFileSync(outputFile, 'utf8')).toBe(
      'opened=false\npr_url=\npackages=\nsummary=lift failed: --today must be a YYYY-MM-DD date, not 2026-10-32\n',
    );
    expect(errors.text()).toContain('renovate-doctor lift error');
  });
});
