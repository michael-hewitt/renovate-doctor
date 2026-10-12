import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseOutcome, readOutcomeFile } from '../lib/outcome.mjs';

const declined = {
  outcome: 'declined',
  classification: 'not-takeable',
  summary: 'vite-plugin-pwa 2 needs vite 8 as a peer, and vite 8 is not published yet.',
  mention: false,
  links: { config_pr: 'https://github.com/crescendosw/webapp/pull/3890' },
};

const parse = (value) => parseOutcome(JSON.stringify(value));

describe('parseOutcome', () => {
  it('accepts a complete outcome file and returns its fields', () => {
    expect(parse(declined)).toEqual({ ok: true, outcome: declined });
  });

  it.each(['merged', 'rerun', 'declined', 'escalated'])('accepts the outcome %s', (outcome) => {
    expect(parse({ outcome, summary: 'Done.' })).toMatchObject({ ok: true, outcome: { outcome } });
  });

  it('accepts skipped, for a PR that moved on before the agent acted, without a classification', () => {
    const summary = 'Renovate pushed a new head (9f8e7d6) before the agent acted; the run on that head decides.';
    expect(parse({ outcome: 'skipped', summary })).toEqual({
      ok: true,
      outcome: { outcome: 'skipped', summary, mention: false, links: {} },
    });
  });

  it('defaults mention to false and links to an empty object, and leaves classification out when absent', () => {
    const result = parse({ outcome: 'rerun', summary: '  The network stalled during install.\n' });
    expect(result).toEqual({
      ok: true,
      outcome: { outcome: 'rerun', summary: 'The network stalled during install.', mention: false, links: {} },
    });
  });

  it('ignores keys the format does not define', () => {
    expect(parse({ ...declined, confidence: 'high' })).toEqual({ ok: true, outcome: declined });
  });

  it('reports text that is not JSON', () => {
    const result = parseOutcome('{"outcome": "merged", "summary": "cut off');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringMatching(/^the file is not valid JSON/)]);
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"merged"'],
  ])('reports a file holding %s rather than an object', (_, text) => {
    expect(parseOutcome(text)).toEqual({ ok: false, problems: ['the file does not hold a JSON object'] });
  });

  it('reports an unknown outcome and a missing one', () => {
    expect(parse({ ...declined, outcome: 'fixed' }).problems).toEqual([
      '"outcome" is "fixed"; it must be one of merged, rerun, declined, escalated, skipped',
    ]);
    const { outcome: _, ...withoutOutcome } = declined;
    expect(parse(withoutOutcome).problems).toEqual([
      '"outcome" is undefined; it must be one of merged, rerun, declined, escalated, skipped',
    ]);
  });

  it('reports an unknown classification', () => {
    expect(parse({ ...declined, classification: 'flaky' }).problems).toEqual([
      '"classification" is "flaky"; it must be one of unrelated, fixable, not-takeable, needs-human, or absent',
    ]);
  });

  it.each([
    ['missing', undefined, 'undefined'],
    ['empty', '', '""'],
    ['blank', '   ', '"   "'],
    ['not a string', 42, '42'],
  ])('reports a %s summary', (_, summary, shown) => {
    expect(parse({ ...declined, summary }).problems).toEqual([`"summary" is ${shown}; it must be a non-empty string`]);
  });

  it('reports a mention that is not a boolean', () => {
    expect(parse({ ...declined, mention: 'yes' }).problems).toEqual([
      '"mention" is "yes"; it must be true, false, or absent',
    ]);
  });

  it('reports links that are not an object of http(s) URLs', () => {
    expect(parse({ ...declined, links: ['https://example.com'] }).problems).toEqual([
      '"links" is ["https://example.com"]; it must be an object of URLs, or absent',
    ]);
    expect(
      parse({ ...declined, links: { config_pr: '#3890', hold_test: 'file:///etc/passwd', other: 7 } }).problems,
    ).toEqual([
      '"links.config_pr" is "#3890"; it must be an http(s) URL',
      '"links.hold_test" is "file:///etc/passwd"; it must be an http(s) URL',
      '"links.other" is 7; it must be an http(s) URL',
    ]);
  });

  it('lists every problem at once', () => {
    const result = parse({ outcome: 'done', summary: '', mention: 1 });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(3);
  });
});

describe('readOutcomeFile', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-outcome-'));

  it('reads and validates a file that exists', () => {
    const file = path.join(temp, 'outcome.json');
    fs.writeFileSync(file, JSON.stringify(declined, null, 2));
    expect(readOutcomeFile(file)).toEqual({ exists: true, parsed: { ok: true, outcome: declined } });
  });

  it('says a malformed file exists, with its problems', () => {
    const file = path.join(temp, 'malformed.json');
    fs.writeFileSync(file, '');
    expect(readOutcomeFile(file)).toMatchObject({ exists: true, parsed: { ok: false } });
  });

  it('says a missing file, or no path at all, does not exist', () => {
    expect(readOutcomeFile(path.join(temp, 'missing.json'))).toEqual({ exists: false });
    expect(readOutcomeFile('')).toEqual({ exists: false });
    expect(readOutcomeFile(undefined)).toEqual({ exists: false });
  });

  it('reports a path that cannot be read as a malformed file rather than throwing', () => {
    const result = readOutcomeFile(temp);
    expect(result.exists).toBe(true);
    expect(result.parsed).toEqual({ ok: false, problems: [expect.stringMatching(/^the file could not be read/)] });
  });
});
