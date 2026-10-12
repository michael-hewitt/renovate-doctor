// outcome - read and validate the outcome file the agent writes at the end of a triage run.
//
// The agent writes `$RUNNER_TEMP/renovate-doctor/outcome.json` (the format is in docs/architecture.md,
// "Outcome file"); the report step reads it to decide between an email and silence. The agent is a
// language model writing JSON by hand, so the file may be missing, truncated or slightly wrong. Nothing
// here throws on bad input: a file that cannot be used comes back as a list of problems, which the
// report step turns into a `failed` email naming them, so a malformed file is never mistaken for
// silence.

import fs from 'node:fs';

/** What the agent did; the report stays silent only for the first two. */
export const outcomes = ['merged', 'rerun', 'declined', 'escalated'];

/** How the agent read the failure, in the skill's terms; optional in the file. */
export const classifications = ['unrelated', 'fixable', 'not-takeable', 'needs-human'];

/**
 * @typedef {{
 *   outcome: 'merged' | 'rerun' | 'declined' | 'escalated',
 *   classification?: 'unrelated' | 'fixable' | 'not-takeable' | 'needs-human',
 *   summary: string,
 *   mention: boolean,
 *   links: Record<string, string>,
 * }} Outcome
 *
 * @typedef {{ ok: true, outcome: Outcome } | { ok: false, problems: string[] }} ParsedOutcome
 */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebUrl(text) {
  try {
    const { protocol } = new URL(text);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function quote(value) {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Parses and validates the text of an outcome file. Every problem is collected rather than only the
 * first, so the email names everything the agent got wrong at once. Keys the format does not define
 * are ignored, so a newer skill writing an extra field does not break an older report step.
 *
 * @param {string} text
 * @returns {ParsedOutcome}
 */
export function parseOutcome(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`the file is not valid JSON (${error?.message ?? error})`] };
  }
  if (!isPlainObject(data)) return { ok: false, problems: ['the file does not hold a JSON object'] };

  const problems = [];
  if (!outcomes.includes(data.outcome)) {
    problems.push(`"outcome" is ${quote(data.outcome)}; it must be one of ${outcomes.join(', ')}`);
  }
  if (data.classification !== undefined && !classifications.includes(data.classification)) {
    problems.push(
      `"classification" is ${quote(data.classification)}; it must be one of ${classifications.join(', ')}, or absent`,
    );
  }
  if (typeof data.summary !== 'string' || !data.summary.trim()) {
    problems.push(`"summary" is ${quote(data.summary)}; it must be a non-empty string`);
  }
  if (data.mention !== undefined && typeof data.mention !== 'boolean') {
    problems.push(`"mention" is ${quote(data.mention)}; it must be true, false, or absent`);
  }
  if (data.links !== undefined && !isPlainObject(data.links)) {
    problems.push(`"links" is ${quote(data.links)}; it must be an object of URLs, or absent`);
  } else {
    for (const [key, value] of Object.entries(data.links ?? {})) {
      if (typeof value !== 'string' || !isWebUrl(value)) {
        problems.push(`"links.${key}" is ${quote(value)}; it must be an http(s) URL`);
      }
    }
  }
  if (problems.length) return { ok: false, problems };

  /** @type {Outcome} */
  const outcome = {
    outcome: data.outcome,
    summary: data.summary.trim(),
    mention: data.mention ?? false,
    links: { ...data.links },
  };
  if (data.classification !== undefined) outcome.classification = data.classification;
  return { ok: true, outcome };
}

/**
 * Reads the outcome file at `path`. A file that is not there (or no path at all) is `exists: false`,
 * which the report step reads together with the agent step's outcome; a file that is there but cannot
 * be read counts as a malformed one. Never throws.
 *
 * @param {string | undefined} path
 * @returns {{ exists: false } | { exists: true, parsed: ParsedOutcome }}
 */
export function readOutcomeFile(path) {
  if (!path) return { exists: false };
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return {
      exists: true,
      parsed: { ok: false, problems: [`the file could not be read (${error?.message ?? error})`] },
    };
  }
  return { exists: true, parsed: parseOutcome(text) };
}
