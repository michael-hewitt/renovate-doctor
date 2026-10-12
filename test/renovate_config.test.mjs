import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createGitGrep, findConditionTests, isValidIsoDate, removeExpiredRules } from '../lib/renovate_config.mjs';

// webapp_renovate.json is crescendosw/webapp's real config: two disabled rules, neither with a marker (one
// has a prose description). renovate_holds.json has one hold of each kind: expired, expiring today, in the
// future, malformed, and a rule with no marker at all. The hold test is webapp's real condition test for
// the @vite-pwa/assets-generator hold.
const fixtures = path.join(import.meta.dirname, 'fixtures');
const text = (name) => fs.readFileSync(path.join(fixtures, name), 'utf8');
const webappConfig = text('webapp_renovate.json');
const holdsConfig = text('renovate_holds.json');
const holdTest = text('pwa_assets_generator_hold.test.ts.txt');

const today = '2026-10-12';

describe('isValidIsoDate', () => {
  it.each(['2026-10-12', '2028-02-29', '2026-12-31'])('accepts %s', (date) => {
    expect(isValidIsoDate(date)).toBe(true);
  });

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-9-1', '12-10-2026', ''])('rejects %s', (date) => {
    expect(isValidIsoDate(date)).toBe(false);
  });
});

describe('removeExpiredRules', () => {
  it("leaves webapp's real config byte-identical: neither disabled rule has a marker", () => {
    expect(removeExpiredRules(webappConfig, today)).toEqual({ text: webappConfig, removed: [], malformed: [] });
  });

  it('removes the expired holds, including one expiring today, and reports their packages', () => {
    const { removed } = removeExpiredRules(holdsConfig, today);
    expect(removed).toEqual([
      {
        packages: ['@vite-pwa/assets-generator'],
        date: '2026-09-30',
        index: 0,
        description:
          'vite-plugin-pwa only accepts the generator at v1 as a peer. remove after 2026-09-30: check whether ' +
          "vite-plugin-pwa's peer range accepts v2",
      },
      {
        packages: ['typescript', '@typescript/native-preview'],
        date: '2026-10-12',
        index: 4,
        description:
          'typescript 7 needs the native preview of the type checker. remove after 2026-10-12: try tsgo on the client',
      },
    ]);
  });

  it('keeps the future hold, the rule without a marker and the malformed one, byte for byte', () => {
    const result = removeExpiredRules(holdsConfig, today);
    const expected = JSON.parse(holdsConfig);
    expected.packageRules = [expected.packageRules[1], expected.packageRules[2], expected.packageRules[3]];
    expect(JSON.parse(result.text)).toEqual(expected);

    // Every line of the result is a line of the original: nothing was reformatted, only rules taken out.
    const original = new Set(holdsConfig.split('\n'));
    expect(result.text.split('\n').filter((line) => !original.has(line))).toEqual([]);
    expect(result.text).toContain('"extends": ["config:recommended"],');
    expect(result.text).toContain(
      '    {\n      "matchPackagePatterns": ["pdfjs-dist"],\n      "enabled": false\n    },\n',
    );
    // The last kept rule closes the array on its own line, as before.
    expect(result.text.endsWith('      "enabled": false\n    }\n  ]\n}\n')).toBe(true);
  });

  it('reports an impossible calendar date as malformed and leaves its rule alone', () => {
    const { malformed, text: trimmed } = removeExpiredRules(holdsConfig, today);
    expect(malformed).toEqual([
      {
        description: 'motion 15 drops the layout prop we use. remove after 2026-02-30: check the migration guide',
        reason: 'not a real calendar date: 2026-02-30',
      },
    ]);
    expect(trimmed).toContain('"matchPackageNames": ["motion"]');
  });

  it('removes nothing before any date has come', () => {
    const result = removeExpiredRules(holdsConfig, '2026-09-29');
    expect(result.text).toBe(holdsConfig);
    expect(result.removed).toEqual([]);
    expect(result.malformed).toHaveLength(1);
  });

  it('removes the packageRules key when its last rule goes', () => {
    const config = [
      '{',
      '  "extends": ["config:recommended"],',
      '  "packageRules": [',
      '    {',
      '      "description": "remove after 2026-01-31: retry",',
      '      "matchPackageNames": ["left-pad"],',
      '      "enabled": false',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n');
    const result = removeExpiredRules(config, today);
    expect(result.text).toBe('{\n  "extends": ["config:recommended"]\n}\n');
    expect(result.removed).toEqual([
      { packages: ['left-pad'], date: '2026-01-31', description: 'remove after 2026-01-31: retry', index: 0 },
    ]);
  });

  it('edits the last packageRules key when the key is written twice, as JSON.parse reads it', () => {
    const config = [
      '{',
      '  "packageRules": [{ "matchPackageNames": ["first"], "enabled": false }],',
      '  "packageRules": [',
      '    { "description": "remove after 2026-01-31: retry", "matchPackageNames": ["a"], "enabled": false },',
      '    { "matchPackageNames": ["b"], "enabled": false }',
      '  ]',
      '}',
      '',
    ].join('\n');
    const result = removeExpiredRules(config, today);
    expect(result.removed.map((rule) => rule.packages)).toEqual([['a']]);
    expect(result.text).toBe(
      [
        '{',
        '  "packageRules": [{ "matchPackageNames": ["first"], "enabled": false }],',
        '  "packageRules": [',
        '    { "matchPackageNames": ["b"], "enabled": false }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('removes packageRules from the middle of the config with the comma after it', () => {
    const config = [
      '{',
      '  "packageRules": [{ "description": "remove after 2026-01-31: retry", "matchPackageNames": ["a"], "enabled": false }],',
      '  "automerge": true',
      '}',
      '',
    ].join('\n');
    expect(removeExpiredRules(config, today).text).toBe('{\n  "automerge": true\n}\n');
  });

  it('only treats disabled rules as holds, and calls a marker that is not the strict form malformed', () => {
    const config = JSON.stringify(
      {
        packageRules: [
          { description: 'remove after 2026-01-31: retry', matchPackageNames: ['a'], automerge: false },
          { description: 'Remove after the next release', matchPackageNames: ['b'], enabled: false },
          { description: 'remove after 2026-1-31: retry', matchPackageNames: ['c'], enabled: false },
          { description: 'REMOVE AFTER 2026-01-31: retry', matchPackageNames: ['d'], enabled: false },
        ],
      },
      null,
      2,
    );
    const result = removeExpiredRules(config, today);
    expect(result.removed.map((rule) => rule.packages)).toEqual([['d']]);
    expect(result.malformed.map((marker) => marker.reason)).toEqual([
      'the rule carries a marker but is not disabled ("enabled": false), so it is not a hold',
      'the marker must read "remove after YYYY-MM-DD: <why>", found "remove after the"',
      'the marker must read "remove after YYYY-MM-DD: <why>", found "remove after 2026-1-31:"',
    ]);
  });

  it('refuses a today that is not a date', () => {
    expect(() => removeExpiredRules(holdsConfig, '2026-10-32')).toThrow('YYYY-MM-DD');
  });
});

describe('findConditionTests', () => {
  // A real repository, so the git grep pathspecs are exercised as the lift runs them.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-conditions-'));
  const files = {
    'renovate.json': holdsConfig,
    'package.json': '{ "devDependencies": { "@vite-pwa/assets-generator": "^1.0.0" } }\n',
    'client/src/util/test/pwa_assets_generator_hold.test.ts': holdTest,
    'client/vite.config.ts': '// pwaAssets loads @vite-pwa/assets-generator at build time.\nexport default {};\n',
    'docs/holds.md': "The '@vite-pwa/assets-generator' hold lives in packageRules.\n",
    'docs/notes.md': "'eslint' is held in renovate.json.\n",
    'tools/__tests__/eslint_hold.js': "// Reads renovate.json for the 'eslint' hold.\n",
    'tools/Eslint.Spec.ts': '// Reads packageRules for the "eslint" hold.\n',
    'tools/test/unquoted.test.js': '// Reads packageRules for the eslint hold, naming it unquoted.\n',
    'client/test/vite_plugin_pwa_hold.test.ts': "const name = 'vite-plugin-pwa'; // read from renovate.json\n",
    'client/test/vite_hold.test.ts': 'const name = "vite"; // read from packageRules\n',
    'node_modules/@vite-pwa/assets-generator/README.md': '@vite-pwa/assets-generator, see renovate.json\n',
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', '-f', '.'], { cwd: repo });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  const gitGrep = createGitGrep(repo);

  it("finds webapp's real hold test, and not a file that only names the package, the config or node_modules", () => {
    expect(findConditionTests('@vite-pwa/assets-generator', { gitGrep })).toEqual([
      'client/src/util/test/pwa_assets_generator_hold.test.ts',
    ]);
  });

  it('ignores a doc page naming the package and packageRules, and still finds the hold test', () => {
    const found = findConditionTests('@vite-pwa/assets-generator', { gitGrep });
    expect(found).not.toContain('docs/holds.md');
    expect(found).toContain('client/src/util/test/pwa_assets_generator_hold.test.ts');
  });

  it('takes a test directory or a .test./.spec. name, in any case, as a test-looking path', () => {
    expect(findConditionTests('eslint', { gitGrep })).toEqual([
      'tools/Eslint.Spec.ts',
      'tools/__tests__/eslint_hold.js',
    ]);
  });

  it('matches the package name only as a quoted string, never inside a longer name', () => {
    expect(findConditionTests('vite', { gitGrep })).toEqual(['client/test/vite_hold.test.ts']);
    expect(findConditionTests('vite-plugin-pwa', { gitGrep })).toEqual(['client/test/vite_plugin_pwa_hold.test.ts']);
  });

  it('finds nothing for a package no file names', () => {
    expect(findConditionTests('left-pad', { gitGrep })).toEqual([]);
  });
});
