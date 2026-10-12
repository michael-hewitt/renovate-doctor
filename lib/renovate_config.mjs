// renovate_config - find and remove expired dated holds in a Renovate config, and the tests guarding them.
//
// A dated hold is a package rule with `"enabled": false` whose description carries
// `remove after YYYY-MM-DD: <why>`, the same marker form as a removal-marker TODO. The lift mode removes
// every hold whose date has come and opens one PR for it; this module is the pure part of that: which
// rules go, what the config text looks like without them, and which tracked files are condition tests
// guarding them.
//
// The config is edited as text, not re-serialised. A Renovate config is usually prettier-formatted, which
// keeps short arrays on one line where `JSON.stringify` would break them, so a parse-and-stringify round
// trip would rewrite lines the lift has no business touching and make its PR's diff lie about what it did.
// Splicing the removed rules out of the original text leaves every other byte as it was.

import { execFileSync } from 'node:child_process';

/**
 * @typedef {{ packages: string[], date: string, description: string, index: number }} RemovedRule
 *   `index` is the rule's position in `packageRules`, counted from 0.
 * @typedef {{ description: string, reason: string }} MalformedMarker
 * @typedef {{ text: string, removed: RemovedRule[], malformed: MalformedMarker[] }} RemovalResult
 *
 * @typedef {Record<string, any>} PackageRule
 *   One entry of `packageRules`, as `JSON.parse` read it; every field is optional and read defensively.
 *
 * @typedef {{ type: 'scalar', start: number, end: number }} JsonScalarNode
 * @typedef {{ type: 'array', start: number, end: number, elements: JsonNode[] }} JsonArrayNode
 * @typedef {{ key: string, start: number, end: number, value: JsonNode }} JsonMember
 * @typedef {{ type: 'object', start: number, end: number, members: JsonMember[] }} JsonObjectNode
 * @typedef {JsonScalarNode | JsonArrayNode | JsonObjectNode} JsonNode
 *   Where a value starts and ends in the config text, as `scan` records it.
 */

/** The marker in its one valid form; the date is checked separately so a bad one can be named. */
const strictMarker = /remove after (\d{4}-\d{2}-\d{2}):/i;

/** Anything that tries to be a marker. One that is not the strict form is malformed, not silently ignored. */
const looseMarker = /remove after\b\s*(\S*)/i;

/**
 * Whether `value` is a real calendar date written as `YYYY-MM-DD` (2026-02-30 is not).
 *
 * @param {string} value
 */
export function isValidIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

/**
 * The packages a rule names, as written: `matchPackageNames`, `matchDepNames`, then
 * `matchPackagePatterns` (patterns are reported as they are, not expanded).
 *
 * @param {PackageRule} rule
 */
export function rulePackages(rule) {
  return [...asList(rule.matchPackageNames), ...asList(rule.matchDepNames), ...asList(rule.matchPackagePatterns)];
}

/** @param {unknown} text */
function oneLine(text) {
  return `${text ?? ''}`.replace(/\s+/g, ' ').trim();
}

/**
 * Reads a rule's marker: `{ date }` for a valid one, `{ reason }` for a malformed one, undefined when the
 * description has none.
 *
 * @param {PackageRule} rule
 * @returns {{ date: string } | { reason: string } | undefined}
 */
function readMarker(rule) {
  const description = typeof rule.description === 'string' ? rule.description : asList(rule.description).join(' ');
  const strict = strictMarker.exec(description);
  if (strict) {
    if (!isValidIsoDate(strict[1])) return { reason: `not a real calendar date: ${strict[1]}` };
    if (rule.enabled !== false) {
      return { reason: 'the rule carries a marker but is not disabled ("enabled": false), so it is not a hold' };
    }
    return { date: strict[1] };
  }
  const loose = looseMarker.exec(description);
  if (!loose) return undefined;
  return {
    reason: `the marker must read "remove after YYYY-MM-DD: <why>", found "remove after ${loose[1] || '(nothing)'}"`,
  };
}

/**
 * A minimal JSON scanner that records where each value starts and ends in the text. It runs only after
 * `JSON.parse` has accepted the text, so it does not report errors of its own.
 *
 * @param {string} text
 * @returns {JsonNode}
 */
function scan(text) {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const skipString = () => {
    i += 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
  };
  /** @returns {JsonNode} */
  function value() {
    skipSpace();
    const start = i;
    const char = text[i];
    if (char === '{') {
      i += 1;
      /** @type {JsonMember[]} */
      const members = [];
      skipSpace();
      while (text[i] !== '}') {
        skipSpace();
        const memberStart = i;
        skipString();
        const key = JSON.parse(text.slice(memberStart, i));
        skipSpace();
        i += 1; // the colon
        const node = value();
        members.push({ key, start: memberStart, end: node.end, value: node });
        skipSpace();
        if (text[i] === ',') i += 1;
        skipSpace();
      }
      i += 1;
      return { type: 'object', start, end: i, members };
    }
    if (char === '[') {
      i += 1;
      /** @type {JsonNode[]} */
      const elements = [];
      skipSpace();
      while (text[i] !== ']') {
        elements.push(value());
        skipSpace();
        if (text[i] === ',') i += 1;
        skipSpace();
      }
      i += 1;
      return { type: 'array', start, end: i, elements };
    }
    if (char === '"') skipString();
    else while (i < text.length && !/[\s,\]}]/.test(text[i])) i += 1;
    return { type: 'scalar', start, end: i };
  }
  return value();
}

/**
 * Splices the items at `indexes` out of a list of spans (array elements or object members) in `text`.
 * Working from the last index back keeps every earlier span valid. An item followed by a kept one takes
 * its trailing comma and the whitespace up to the next item with it; the last kept-so-far item takes the
 * comma and whitespace before it instead, so the closing bracket keeps its own line and indentation.
 *
 * @param {string} text
 * @param {{ start: number, end: number }[]} items
 * @param {number[]} indexes
 */
function spliceOut(text, items, indexes) {
  const removing = new Set(indexes);
  let result = text;
  for (let k = items.length - 1; k >= 0; k -= 1) {
    if (!removing.has(k)) continue;
    const laterKept = items.slice(k + 1).some((_, offset) => !removing.has(k + 1 + offset));
    if (laterKept) result = result.slice(0, items[k].start) + result.slice(items[k + 1].start);
    else if (k > 0) result = result.slice(0, items[k - 1].end) + result.slice(items[k].end);
    else result = result.slice(0, items[k].start) + result.slice(items[k].end);
  }
  return result;
}

/**
 * Removes every expired dated hold from a Renovate config's text. Expired means the marker's date is
 * today or earlier (`today` is `YYYY-MM-DD`). A rule whose marker is malformed is reported and kept;
 * rules without a marker, and every byte outside the removed rules, are left exactly as they were. When
 * no rule is left in `packageRules`, the key goes too.
 *
 * @param {string} text the config file's contents (JSON; a JSON5 config is not supported)
 * @param {string} today
 * @returns {RemovalResult}
 */
export function removeExpiredRules(text, today) {
  if (!isValidIsoDate(today)) throw new Error(`today must be a YYYY-MM-DD date, not ${today}`);
  const config = JSON.parse(text);
  /** @type {PackageRule[]} */
  const rules = Array.isArray(config?.packageRules) ? config.packageRules : [];

  /** @type {RemovedRule[]} */
  const removed = [];
  /** @type {MalformedMarker[]} */
  const malformed = [];
  /** @type {number[]} */
  const expiredIndexes = [];
  rules.forEach((rule, index) => {
    const marker = rule && typeof rule === 'object' ? readMarker(rule) : undefined;
    if (!marker) return;
    const description = oneLine(rule.description);
    if ('reason' in marker) {
      malformed.push({ description, reason: marker.reason });
      return;
    }
    if (marker.date > today) return;
    removed.push({ packages: rulePackages(rule), date: marker.date, description, index });
    expiredIndexes.push(index);
  });
  if (!expiredIndexes.length) return { text, removed, malformed };

  // `JSON.parse` found `packageRules` above, so the root is an object and the member holds an array.
  const root = /** @type {JsonObjectNode} */ (scan(text));
  // With the key written twice, `JSON.parse` keeps the last one, so the rules found above are the last
  // one's and the splice must be made there too.
  const memberIndex = root.members.findLastIndex((member) => member.key === 'packageRules');
  const rulesNode = /** @type {JsonArrayNode} */ (root.members[memberIndex].value);
  let trimmed;
  if (expiredIndexes.length === rulesNode.elements.length) {
    trimmed =
      root.members.length === 1
        ? text.slice(0, root.start + 1) + text.slice(root.end - 1)
        : spliceOut(text, root.members, [memberIndex]);
  } else {
    trimmed = spliceOut(text, rulesNode.elements, expiredIndexes);
  }
  return { text: trimmed, removed, malformed };
}

/**
 * Runs `git grep <args>` in `cwd` and returns the matching paths; no match is an empty list, not an error.
 *
 * @param {string} [cwd]
 * @returns {(args: string[]) => string[]}
 */
export function createGitGrep(cwd = process.cwd()) {
  return (args) => {
    try {
      const stdout = execFileSync('git', ['grep', ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return stdout.split('\n').filter(Boolean);
    } catch (/** @type {any} */ error) {
      if (error?.status === 1) return [];
      throw error;
    }
  };
}

/**
 * The marker a condition test carries, on a line of its own, for each package whose hold it guards.
 *
 * @param {string} packageName
 */
export function holdMarker(packageName) {
  return `renovate-doctor hold: ${packageName}`;
}

// Renovate config files and package manifests (package.json can hold a `renovate` key) are never condition
// tests, whatever they contain: deleting one with a hold would break the project.
const configFileNames = new Set([
  'renovate.json',
  'renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.renovaterc.json5',
  'package.json',
]);

/** @param {string} file */
function isConfigFile(file) {
  return configFileNames.has(file.split('/').at(-1) ?? '');
}

/** @param {string} text */
function escapeExtendedRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const testDirectories = new Set(['test', 'tests', '__tests__', 'spec']);

// Only a file whose path looks like a test can be a condition test, so a doc page that quotes a marker (as
// this repository's README does) is never deleted with a hold.
/** @param {string} file */
function looksLikeTest(file) {
  const segments = file.toLowerCase().split('/');
  const name = segments.pop() ?? '';
  return segments.some((segment) => testDirectories.has(segment)) || /\.(test|spec)\./.test(name);
}

/**
 * The tracked files outside `node_modules` that are condition tests guarding a hold on `packageName`:
 * files whose path looks like a test (a `test`, `tests`, `__tests__` or `spec` directory, or `.test.` or
 * `.spec.` in the name) and which carry the marker `renovate-doctor hold: <packageName>` in a comment.
 * Nothing else counts: a test may well name other packages (the other side of a peer check, say), and only
 * the marker says which hold it guards. Renovate config files and package manifests are never included.
 *
 * @param {string} packageName
 * @param {{ gitGrep?: (args: string[]) => string[] }} [options]
 * @returns {string[]}
 */
export function findConditionTests(packageName, { gitGrep = createGitGrep() } = {}) {
  const outsideNodeModules = ['.', ':(exclude,glob)**/node_modules/**'];
  // The marker must end the line (bar a comment closer), so the marker for `vite` is not found inside the
  // one for `vite-plugin-pwa`; a fixed-string search would match that prefix.
  const marker = `${escapeExtendedRegExp(holdMarker(packageName))}[[:space:]]*(\\*/|-->)?[[:space:]]*$`;
  return gitGrep(['-l', '-E', '-e', marker, '--', ...outsideNodeModules])
    .filter((file) => looksLikeTest(file) && !isConfigFile(file))
    .sort();
}
