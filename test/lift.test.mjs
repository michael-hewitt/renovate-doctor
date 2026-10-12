import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { formatPrBody, lift, liftMarker, main, parseArgs, prTitle, summarize, toOutputs } from '../scripts/lift.mjs';

// The lift runs against a real git repository cloned from a bare `origin`, so its branch, commit, push and
// dry-run restore are the real thing; only GitHub is faked. renovate_holds.json has two expired holds
// (@vite-pwa/assets-generator, and typescript expiring today), a future one, a malformed one and one with
// no marker; the hold test is crescendosw/webapp's real condition test for the first.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const text = (/** @type {string} */ name) => fs.readFileSync(path.join(fixtures, name), 'utf8');
const holdsConfig = text('renovate_holds.json');
const webappConfig = text('webapp_renovate.json');
// webapp's real hold test, with the marker line the lift finds condition tests by.
const holdTest = `// renovate-doctor hold: @vite-pwa/assets-generator\n${text('pwa_assets_generator_hold.test.ts.txt')}`;

const repository = 'crescendosw/webapp';
const today = '2026-10-12';
const branch = 'renovate-doctor/lift-2026-10-12';
const prUrl = 'https://github.com/crescendosw/webapp/pull/3901';
const openPrsRoute = `repos/${repository}/pulls?state=open&per_page=100`;
const branchPrsRoute = `repos/${repository}/pulls?head=crescendosw%3Arenovate-doctor%2Flift-2026-10-12&state=open&per_page=100`;
const protectionRoute = `repos/${repository}/branches/main/protection/required_status_checks`;
const rulesRoute = `repos/${repository}/rules/branches/main`;
const requiredChecks = { strict: true, contexts: ['Node.js CI'], checks: [{ context: 'Node.js CI', app_id: 15368 }] };

/**
 * An error as `gh api` raises it for an HTTP failure.
 *
 * @param {number} status
 * @param {string} message
 */
function ghError(status, message) {
  return () => {
    throw Object.assign(new Error(`Command failed: gh api`), { stderr: `gh: ${message} (HTTP ${status})\n` });
  };
}
const holdTestPath = 'client/src/util/test/pwa_assets_generator_hold.test.ts';

// Git with no global or system config, so the identity fallback is tested on every machine alike.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** @type {import('../scripts/lift.mjs').Exec} */
const exec = (file, args, { cwd } = {}) =>
  execFileSync(file, args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => exec('git', args, { cwd });

/** @type {string[]} */
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
/** @param {Record<string, unknown>} [responses] */
function fakeGithub(responses = {}) {
  /** @type {{ route?: string, gh?: string[], method?: string, body?: any }[]} */
  const calls = [];
  return {
    calls,
    /** @type {import('../lib/github.mjs').GhApi} */
    ghApi(route, options = {}) {
      calls.push({ route, ...options });
      if (!(route in responses)) throw new Error(`unexpected route ${route}`);
      const answer = responses[route];
      return typeof answer === 'function' ? answer(options) : structuredClone(answer);
    },
    /** @param {string[]} args */
    gh(args) {
      calls.push({ gh: args });
      return '';
    },
  };
}

function capture() {
  /** @type {string[]} */
  const lines = [];
  return { out: (/** @type {string} */ line) => lines.push(line), text: () => lines.join('') };
}

const githubForNewPr = (/** @type {Record<string, unknown>} */ overrides = {}) =>
  fakeGithub({
    [openPrsRoute]: [],
    [`repos/${repository}`]: { default_branch: 'main' },
    [protectionRoute]: requiredChecks,
    [`repos/${repository}/pulls`]: { number: 3901, html_url: prUrl },
    ...overrides,
  });

const lifted3 = 'lifted 2 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview';

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
    expect(toOutputs(result)).toEqual({
      opened: 'false',
      blocked: 'false',
      pr_url: '',
      packages: '',
      removed: '0',
      summary: 'nothing expired',
    });
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
      summary: lifted3,
    });
    expect(toOutputs(result)).toEqual({
      opened: 'true',
      blocked: 'false',
      pr_url: prUrl,
      packages: '@vite-pwa/assets-generator,typescript,@typescript/native-preview',
      removed: '2',
      summary: lifted3,
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
    expect(
      pushedConfig.packageRules.map((/** @type {any} */ rule) => rule.matchPackageNames ?? rule.matchPackagePatterns),
    ).toEqual([['pdfjs-dist'], ['eslint'], ['motion']]);

    // The PR: its title, base, head and body, then squash auto-merge.
    const create = github.calls.find((call) => call.route === `repos/${repository}/pulls`);
    expect(create?.method).toBe('POST');
    expect(create?.body).toMatchObject({ title, head: branch, base: 'main' });
    expect(create?.body.body).toContain(
      '\nLifted holds:\n' +
        '- @vite-pwa/assets-generator (held until 2026-09-30): vite-plugin-pwa only accepts the generator at v1 as a ' +
        "peer. remove after 2026-09-30: check whether vite-plugin-pwa's peer range accepts v2\n" +
        '- typescript (held until 2026-10-12): typescript 7 needs the native preview of the type checker. remove ' +
        'after 2026-10-12: try tsgo on the client\n' +
        '- @typescript/native-preview (held until 2026-10-12): typescript 7 needs the native preview of the type ' +
        'checker. remove after 2026-10-12: try tsgo on the client\n',
    );
    expect(create?.body.body).toContain(`\nDeleted condition tests:\n- ${holdTestPath}\n`);
    expect(create?.body.body).toContain(
      '\nNot touched (malformed marker):\n- motion 15 drops the layout prop we use. remove after 2026-02-30: check ' +
        'the migration guide (not a real calendar date: 2026-02-30)\n',
    );
    expect(create?.body.body.trimEnd().endsWith(liftMarker)).toBe(true);
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
    const existing = {
      number: 3899,
      html_url: 'https://github.com/x/y/pull/3899',
      head: { ref: branch, repo: { full_name: repository } },
    };
    const github = githubForNewPr({ [openPrsRoute]: [{ ...existing, body: liftMarker }] });
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });

    expect(result).toMatchObject({ opened: true, prUrl: 'https://github.com/x/y/pull/3899', reused: true });
    expect(github.calls.map((call) => call.route ?? call.gh?.join(' '))).toEqual([
      `repos/${repository}`,
      openPrsRoute,
      protectionRoute,
      'pr merge https://github.com/x/y/pull/3899 --auto --squash',
    ]);
    expect(git(origin, ['branch', '--list']).trim()).toBe('* main');
    expect(git(work, ['status', '--porcelain'])).toBe('');
  });

  it('takes the PR found on the branch when creating it failed after GitHub had made it', () => {
    const { work } = makeRepo();
    const github = fakeGithub({
      [openPrsRoute]: [],
      [branchPrsRoute]: [{ number: 3901, html_url: prUrl, head: { ref: branch, repo: { full_name: repository } } }],
      [`repos/${repository}`]: { default_branch: 'main' },
      [protectionRoute]: requiredChecks,
      [`repos/${repository}/pulls`]: () => {
        throw new Error('gh: Validation Failed: A pull request already exists (HTTP 422)');
      },
    });
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });
    expect(result).toMatchObject({ opened: true, prUrl });
    expect(github.calls.at(-1)).toEqual({ gh: ['pr', 'merge', prUrl, '--auto', '--squash'] });
  });

  it('lifts nothing while an earlier lift PR is still open, and says so', () => {
    const { origin, work } = makeRepo();
    const earlier = {
      number: 3880,
      html_url: 'https://github.com/crescendosw/webapp/pull/3880',
      head: { ref: 'renovate-doctor/lift-2026-09-12', repo: { full_name: repository } },
      body: `Lifted holds:\n- eslint (held until 2026-09-01): retry\n\n${liftMarker}\n`,
    };
    const unrelated = {
      number: 3886,
      html_url: 'https://x/3886',
      head: { ref: 'renovate/x', repo: { full_name: repository } },
      body: 'Renovate',
    };
    const github = githubForNewPr({ [openPrsRoute]: [unrelated, earlier] });
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });

    expect(toOutputs(result)).toEqual({
      opened: 'false',
      blocked: 'true',
      pr_url: earlier.html_url,
      packages: '@vite-pwa/assets-generator,typescript,@typescript/native-preview',
      removed: '2',
      summary: `previous lift PR still open: ${earlier.html_url}`,
    });
    expect(github.calls.map((call) => call.route ?? call.gh?.join(' '))).toEqual([`repos/${repository}`, openPrsRoute]);
    expect(git(origin, ['branch', '--list']).trim()).toBe('* main');
    expect(git(work, ['status', '--porcelain'])).toBe('');
  });

  it("ignores a fork's PR named like today's lift branch, and pushes its own", () => {
    const { origin, work } = makeRepo();
    const fork = {
      number: 3999,
      html_url: 'https://github.com/crescendosw/webapp/pull/3999',
      head: { ref: branch, repo: { full_name: 'stranger/webapp' } },
      body: liftMarker,
    };
    const github = githubForNewPr({ [openPrsRoute]: [fork] });
    const result = lift({ today, repository, cwd: work }, { github, exec, out: () => {} });

    expect(result).toMatchObject({ opened: true, prUrl });
    expect(result.reused).toBeUndefined();
    expect(github.calls.filter((call) => call.gh)).toEqual([{ gh: ['pr', 'merge', prUrl, '--auto', '--squash'] }]);
    expect(git(origin, ['rev-parse', `${branch}~1`])).toBe(git(origin, ['rev-parse', 'main']));
  });

  it('is not blocked by an open PR carrying the lift marker on a branch that is not a lift branch', () => {
    const quoting = {
      number: 3998,
      html_url: 'https://github.com/crescendosw/webapp/pull/3998',
      head: { ref: 'docs/explain-the-lift', repo: { full_name: repository } },
      body: `The lift PR body ends with ${liftMarker}.`,
    };
    const github = githubForNewPr({ [openPrsRoute]: [quoting] });
    const result = lift({ today, repository, cwd: makeRepo().work }, { github, exec, out: () => {} });
    expect(result).toMatchObject({ opened: true, prUrl });
    expect(result.blocked).toBeUndefined();
  });

  it('replaces its own branch left on the remote by an earlier run today that opened no PR', () => {
    const { origin, work } = makeRepo();
    git(work, ['-c', 'user.name=M', '-c', 'user.email=m@example.com', 'commit', '-q', '--allow-empty', '-m', 'stale']);
    git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    git(work, ['reset', '-q', '--hard', 'origin/main']);
    const output = capture();
    const result = lift({ today, repository, cwd: work }, { github: githubForNewPr(), exec, out: output.out });

    expect(result).toMatchObject({ opened: true, prUrl });
    expect(output.text()).toContain('is on the remote from an earlier run with no open PR; deleting it first');
    expect(git(origin, ['log', '-1', '--format=%s', `${branch}~1`]).trim()).toBe('initial');
  });

  describe('auto-merge and the required checks', () => {
    const autoMergeCalls = (/** @type {ReturnType<typeof fakeGithub>} */ github) =>
      github.calls.filter((call) => call.gh?.[0] === 'pr');

    it('enables auto-merge when a ruleset requires checks and branch protection is absent', () => {
      const github = githubForNewPr({
        [protectionRoute]: ghError(404, 'Branch not protected'),
        [rulesRoute]: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI' }] } }],
      });
      const result = lift({ today, repository, cwd: makeRepo().work }, { github, exec, out: () => {} });
      expect(autoMergeCalls(github)).toEqual([{ gh: ['pr', 'merge', prUrl, '--auto', '--squash'] }]);
      expect(result.summary).toBe(lifted3);
    });

    it('leaves auto-merge off, and says so, when the default branch requires no checks', () => {
      const github = githubForNewPr({ [protectionRoute]: ghError(404, 'Branch not protected'), [rulesRoute]: [] });
      const result = lift({ today, repository, cwd: makeRepo().work }, { github, exec, out: () => {} });
      expect(autoMergeCalls(github)).toEqual([]);
      expect(result).toMatchObject({ opened: true, prUrl });
      expect(result.summary).toBe(
        `${lifted3}; auto-merge was not enabled because the default branch requires no checks`,
      );
      const create = github.calls.find((call) => call.method === 'POST');
      expect(create?.body.body).toContain('Auto-merge was not enabled: the default branch requires no status checks');
    });

    it('enables auto-merge with a note when the protection cannot be read', () => {
      const github = githubForNewPr({ [protectionRoute]: ghError(403, 'Resource not accessible by integration') });
      const result = lift({ today, repository, cwd: makeRepo().work }, { github, exec, out: () => {} });
      expect(autoMergeCalls(github)).toHaveLength(1);
      expect(result.summary).toBe(
        `${lifted3}; auto-merge was enabled, but the default branch's protection could not be read ` +
          '(branch protection: gh: Resource not accessible by integration (HTTP 403))',
      );
    });
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
        'dry run: would lift 2 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview',
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

describe('prTitle and summarize', () => {
  it('name a rule that matches no package by name by its position and description, and count holds', () => {
    const removed = [
      { packages: ['a', 'b'], date: '2026-01-01', description: 'remove after 2026-01-01: retry', index: 0 },
      {
        packages: [],
        date: '2026-01-01',
        description: 'Internal packages wait for the v3 API. remove after 2026-01-01: retry',
        index: 5,
      },
    ];
    expect(prTitle(removed)).toBe(
      'chore(deps): lift expired Renovate holds (a, b, rule 5: Internal packages wait for the v3 API. r)',
    );
    expect(summarize(removed)).toBe('lifted 2 expired holds: a, b, rule 5: Internal packages wait for the v3 API. r');
  });

  it('report a lifted prefix-only rule in `removed` even though it adds nothing to `packages`', () => {
    const removed = [{ packages: [], date: '2026-01-01', description: 'Internal packages.', index: 2 }];
    const outputs = toOutputs({ opened: false, prUrl: '', packages: [], removed, summary: summarize(removed) });
    expect(outputs).toMatchObject({
      packages: '',
      removed: '1',
      summary: 'lifted 1 expired hold: rule 2: Internal packages.',
    });
  });
});

describe('formatPrBody', () => {
  it('leaves out the sections that have nothing in them', () => {
    const body = formatPrBody({
      removed: [
        { packages: ['left-pad'], date: '2026-01-31', description: 'remove after 2026-01-31: retry', index: 0 },
      ],
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
      'opened=false\nblocked=false\npr_url=\npackages=@vite-pwa/assets-generator,typescript,@typescript/native-preview\n' +
        'removed=2\n' +
        'summary=dry run: would lift 2 expired holds: @vite-pwa/assets-generator, typescript, @typescript/native-preview\n',
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
      'opened=false\nblocked=false\npr_url=\npackages=\nremoved=0\nsummary=lift failed: --today must be a YYYY-MM-DD date, not 2026-10-32\n',
    );
    expect(errors.text()).toContain('renovate-doctor lift error');
  });

  it('writes the outputs and the exit code to $RUNNER_TEMP/renovate-doctor/lift.json for the next step', () => {
    const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-lift-'));
    roots.push(runnerTemp);
    const resultFile = path.join(runnerTemp, 'renovate-doctor', 'lift.json');
    const run = (/** @type {string[]} */ argv) => {
      const code = main({
        argv,
        env: { GITHUB_REPOSITORY: repository, RUNNER_TEMP: runnerTemp },
        github: githubForNewPr(),
        exec,
        cwd: makeRepo().work,
        out: () => {},
        err: () => {},
      });
      return { code, result: JSON.parse(fs.readFileSync(resultFile, 'utf8')) };
    };

    expect(run(['--today', today])).toEqual({
      code: 0,
      result: {
        opened: 'true',
        blocked: 'false',
        pr_url: prUrl,
        packages: '@vite-pwa/assets-generator,typescript,@typescript/native-preview',
        removed: '2',
        summary: lifted3,
        exit_code: 0,
      },
    });
    expect(run(['--today', 'tomorrow'])).toEqual({
      code: 1,
      result: {
        opened: 'false',
        blocked: 'false',
        pr_url: '',
        packages: '',
        removed: '0',
        summary: 'lift failed: --today must be a YYYY-MM-DD date, not tomorrow',
        exit_code: 1,
      },
    });
  });
});
