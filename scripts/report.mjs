// report - after the agent, send the one email a run produces, or stay silent, and say which and why.
//
// The only step of the workflow's `report` job, which runs after the triage or lift job, on a GitHub-hosted
// runner, from a fresh checkout of this repository: the mail key never shares a job with the install or
// the agent. In triage mode it runs whenever the gate launched the agent or produced an outcome itself,
// and when the triage job failed before the gate ran; it reads the outcome file the triage job handed over
// as an artifact. In lift mode it always runs. It reads no file from the caller's repository. The rules are the report contract in
// docs/architecture.md: a `merged` or `rerun` outcome is silent unless the agent asked for a mention, and
// a `skipped` one (the PR moved on before the agent acted) is always silent; everything else (declined,
// escalated, a run that failed, an agent that wrote no or a malformed outcome file) is one plain-text
// email through Mandrill. When the gate produced the outcome no agent ran: for fix attempts exhausted
// (`escalated`) this step also posts the PR comment, with the sha marker, on the gate's behalf; for a
// gate error (`failed`) it only emails. In lift mode it emails when a config PR was opened, when the lift
// was blocked by an earlier lift PR that is still open, and when the lift failed; it is silent when
// nothing had expired.
//
// Environment: REPORT_MODE (`triage`/`lift`), OUTCOME_FILE, AGENT_OUTCOME (the agent step's outcome:
// `success`/`failure`/`cancelled`/`skipped`), TRIAGE_RESULT (the triage job's result; with no gate output
// at all, `failure` or `cancelled` means the job broke before the gate ran, which is emailed), GATE_OUTCOME, GATE_SUMMARY, GATE_REASON, DRY_RUN
// (`true`/`false`), PR_NUMBER, PR_URL, PR_TITLE, HEAD_SHA, RUN_URL, GITHUB_REPOSITORY, GH_TOKEN (read by
// `gh`), EMAIL_TO, EMAIL_FROM, EMAIL_FROM_NAME, MANDRILL_API_KEY; for lift mode LIFT_OUTCOME
// (`opened`/`nothing`/`blocked`/`failure`), LIFT_PR_URL, LIFT_SUMMARY.
//
// Exit status: non-zero when an email was due and was not sent (refused by Mandrill, or the mail settings
// are missing), and when REPORT_MODE is not one this script knows. The email is what a non-merged run
// produces, so losing it must show as a failed step. A comment that could not be posted is only logged:
// the email already carries the news. Silence and a dry run exit 0.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createGithub } from '../lib/github.mjs';
import { sendEmail } from '../lib/mandrill.mjs';
import { readOutcomeFile } from '../lib/outcome.mjs';
import { handledMarker } from './gate.mjs';

/**
 * @typedef {import('../lib/outcome.mjs').OutcomeFile} OutcomeFile
 *
 * @typedef {{
 *   mode: 'triage' | 'lift' | string,
 *   outcome?: OutcomeFile,
 *   agentOutcome?: string,
 *   triageResult?: string,
 *   gate?: { outcome?: string, summary?: string, reason?: string },
 *   pr?: { number?: number | string, url?: string, title?: string, headSha?: string },
 *   runUrl?: string,
 *   repository?: string,
 *   lift?: { outcome?: string, prUrl?: string, summary?: string },
 * }} ReportInput
 *   `outcome` is what `readOutcomeFile` returned for the outcome file.
 *
 * @typedef {{
 *   outcome: string,
 *   summary: string,
 *   links: Record<string, string>,
 *   email: boolean,
 *   fromGate: boolean,
 *   why: string,
 *   beforeGate?: boolean,
 * }} Resolution
 *
 * @typedef {{ subject: string, text: string, comment?: string }} Message
 */

const subjectPrefix = '[renovate-doctor]';

/** The outcomes the agent may report without an email, unless it asks for a mention. */
const quietOutcomes = ['merged', 'rerun'];

/**
 * The outcomes that never email: the PR closed or Renovate pushed a new head before the agent acted, so
 * there is nothing to tell, and the run on the new head speaks for itself.
 */
const silentOutcomes = ['skipped'];

/**
 * The PR comment the report posts when the gate produced the outcome, in the form every renovate-doctor
 * comment takes: the marker with the sha and the outcome on its own line (which the gate's "not handled"
 * check reads), a bold heading, the outcome, and the summary.
 *
 * @param {string} headSha
 * @param {string} outcome
 * @param {string} summary
 */
export function formatComment(headSha, outcome, summary) {
  return `${handledMarker(headSha, outcome)}\n**renovate-doctor**\n\nOutcome: ${outcome}\n\n${summary}\n`;
}

/**
 * Works out the triage outcome from what the gate, the agent step and the outcome file left behind, and
 * whether it is worth an email. The gate's outcome comes first because when it produced one no agent ran,
 * so there can be no outcome file to read.
 *
 * @param {ReportInput} input
 * @returns {Resolution}
 */
export function resolveTriage({ outcome: file = { exists: false }, agentOutcome = '', triageResult = '', gate = {} }) {
  const agentRan = agentOutcome !== 'skipped' && agentOutcome !== '';
  // The gate always writes a reason, so none (and no outcome from it) means the triage job broke before the
  // gate ran: a checkout, a Node setup, a misspelt package_manager, a lost runner. Without this the run
  // would be red and silent on every Renovate failure until someone looked.
  const failedEarly = triageResult === 'failure' || triageResult === 'cancelled';
  if (failedEarly && !gate.reason && !gate.outcome && !agentRan && !file.exists) {
    const how = triageResult === 'failure' ? 'failed' : 'was cancelled';
    return {
      outcome: 'failed',
      summary:
        `The run failed: the triage job ${how} before the gate ran, so no PR was looked at. The run log says ` +
        'which step; a mistake in the caller workflow (an input, the runner label) fails every run the same way.',
      links: {},
      email: true,
      fromGate: false,
      why: `failed: the triage job ${how} before the gate ran`,
      beforeGate: true,
    };
  }
  if (gate.outcome && !agentRan) {
    const reason = gate.reason ? ` (${gate.reason})` : '';
    return {
      outcome: gate.outcome,
      summary: gate.summary || `The gate decided ${gate.outcome} without launching the agent${reason}.`,
      links: {},
      email: true,
      fromGate: true,
      why: `${gate.outcome}, produced by the gate${reason}; the agent did not run`,
    };
  }

  if (file.exists && file.parsed.ok) {
    const { outcome, summary, mention, links } = file.parsed.outcome;
    if (silentOutcomes.includes(outcome)) {
      return { outcome, summary, links, email: false, fromGate: false, why: `${outcome}, from the outcome file` };
    }
    const email = !quietOutcomes.includes(outcome) || mention;
    let why = `${outcome}, from the outcome file`;
    if (quietOutcomes.includes(outcome)) why += mention ? ', and the agent asked for a mention' : ', with no mention';
    return { outcome, summary, links, email, fromGate: false, why };
  }

  if (file.exists) {
    const { problems } = /** @type {{ ok: false, problems: string[] }} */ (file.parsed);
    return {
      outcome: 'failed',
      summary: [
        'The run failed: the agent wrote an outcome file renovate-doctor could not use, so what it did on the PR',
        'is not known from here. The problems with the file:',
        ...problems.map((problem) => `- ${problem}`),
        'The run log and the transcript artifact show what the agent did.',
      ].join('\n'),
      links: {},
      email: true,
      fromGate: false,
      why: `failed: the outcome file is malformed (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
    };
  }

  if (agentOutcome === 'success') {
    return {
      outcome: 'escalated',
      summary:
        'The agent wrote no outcome: its step finished without error but left no outcome file, so whether it ' +
        'changed anything on the PR is not known from here. The run log and the transcript artifact show what ' +
        'it did; until a person looks, the PR is as the agent left it.',
      links: {},
      email: true,
      fromGate: false,
      why: 'escalated: the agent step succeeded but wrote no outcome file',
    };
  }

  // A skipped agent step with no outcome from the gate means a step before it (service setup or install,
  // most likely) failed after the gate launched; that is a failed run as much as a crashed agent is.
  const how =
    agentOutcome === 'failure' || agentOutcome === 'cancelled'
      ? `the agent step ${agentOutcome === 'failure' ? 'failed' : 'was cancelled'} before writing an outcome`
      : agentOutcome === 'skipped'
        ? 'the agent did not run, because a step before it (service setup or install, most likely) failed'
        : `the agent step's outcome is ${agentOutcome ? `"${agentOutcome}"` : 'unknown'} and it wrote no outcome`;
  return {
    outcome: 'failed',
    summary: `The run failed: ${how}, so nothing says what, if anything, changed on the PR. The run log has the details.`,
    links: {},
    email: true,
    fromGate: false,
    why: `failed: the agent step concluded ${agentOutcome || 'nothing'} and there is no outcome file`,
  };
}

/** @param {string | undefined} text */
function firstLine(text) {
  return `${text ?? ''}`.trim().split('\n')[0].trim();
}

/**
 * @param {string | undefined} url
 * @param {string} what
 */
function linkOrUnknown(url, what) {
  return url || `(${what} not given)`;
}

/**
 * @param {ReportInput} input
 * @returns {Message | undefined}
 */
function composeTriage(input) {
  const resolution = resolveTriage(input);
  if (!resolution.email) return undefined;
  const { pr = {}, runUrl, repository } = input;
  const title = pr.title || (pr.number ? `PR #${pr.number}` : resolution.beforeGate ? 'triage job' : 'an unknown PR');
  const links = [`PR: ${linkOrUnknown(pr.url, 'PR URL')}`, `Run: ${linkOrUnknown(runUrl, 'run URL')}`];
  if (resolution.links.config_pr) links.push(`Config PR: ${resolution.links.config_pr}`);
  /** @type {Message} */
  const message = {
    subject: `${subjectPrefix} ${resolution.outcome}: ${title}`,
    text: [resolution.summary, '', ...links, '', `Repository: ${repository || '(unknown)'}`].join('\n'),
  };
  // A comment without the marker would not stop the gate from launching again on the same head, so the
  // gate's comment needs the head sha (which the gate always outputs alongside an outcome). Only the
  // gate's `escalated` is commented: a gate error (`failed`) says nothing about the PR, and its marker
  // would count as handled and silence the next triage of the same head.
  if (resolution.fromGate && resolution.outcome === 'escalated' && pr.headSha) {
    message.comment = formatComment(pr.headSha, resolution.outcome, resolution.summary);
  }
  return message;
}

const liftOutcomes = ['opened', 'nothing', 'blocked', 'failure'];

/**
 * Lift mode's decision: an email for an opened config PR, a lift blocked by an open one, or a failure;
 * silence when nothing had expired.
 * An outcome this script does not know is treated as a failure, so a broken lift job is never silent.
 *
 * @param {ReportInput} input
 * @returns {{ email: boolean, why: string }}
 */
export function resolveLift({ lift = {} }) {
  const outcome = lift.outcome ?? '';
  if (outcome === 'nothing') return { email: false, why: 'lift: nothing had expired' };
  if (outcome === 'opened') return { email: true, why: `lift: opened ${lift.prUrl || 'a config PR'}` };
  if (outcome === 'blocked') return { email: true, why: `lift: blocked by ${lift.prUrl || 'an open lift PR'}` };
  if (outcome === 'failure') return { email: true, why: 'lift: the lift failed' };
  return {
    email: true,
    why: `lift: LIFT_OUTCOME is ${outcome ? `"${outcome}"` : 'empty'}, not one of ${liftOutcomes.join(', ')}; reported as a failure`,
  };
}

/**
 * @param {ReportInput} input
 * @returns {Message | undefined}
 */
function composeLift(input) {
  const { lift = {}, runUrl, repository } = input;
  if (!resolveLift(input).email) return undefined;
  const footer = ['', `Repository: ${repository || '(unknown)'}`];
  const run = `Run: ${linkOrUnknown(runUrl, 'run URL')}`;
  if (lift.outcome === 'opened') {
    const summary = lift.summary?.trim() || 'renovate-doctor opened a PR lifting expired Renovate holds.';
    return {
      subject: `${subjectPrefix} lift: ${firstLine(summary)}`,
      text: [summary, '', `PR: ${linkOrUnknown(lift.prUrl, 'PR URL')}`, run, ...footer].join('\n'),
    };
  }
  if (lift.outcome === 'blocked') {
    // An unmerged lift PR keeps every later lift from running, so it needs a person even though nothing
    // failed: a month of silence would hide it.
    const summary = lift.summary?.trim() || 'the previous lift PR is still open';
    return {
      subject: `${subjectPrefix} lift blocked`,
      text: [
        `lift blocked: ${summary}`,
        '',
        'Nothing was lifted this run. Merge or close the open lift PR; the next lift run then lifts every hold ' +
          'that has expired by then.',
        '',
        ...(lift.prUrl ? [`PR: ${lift.prUrl}`] : []),
        run,
        ...footer,
      ].join('\n'),
    };
  }
  let summary = lift.summary?.trim() || 'The lift run failed; the run log says where.';
  if (lift.outcome !== 'failure') {
    summary = `The lift step reported an outcome renovate-doctor does not know (${lift.outcome ? `"${lift.outcome}"` : 'none'}). ${summary}`;
  }
  const links = lift.prUrl ? [`PR: ${lift.prUrl}`, run] : [run];
  return { subject: `${subjectPrefix} lift failed`, text: [summary, '', ...links, ...footer].join('\n') };
}

/**
 * The email (and, for a gate-produced outcome, the PR comment) a run produces, or undefined for silence.
 *
 * @param {ReportInput} input
 * @returns {Message | undefined}
 */
export function compose(input) {
  if (input.mode === 'lift') return composeLift(input);
  return composeTriage(input);
}

/**
 * The one line saying what the report decided and why.
 *
 * @param {ReportInput} input
 */
export function explain(input) {
  const { email, why } = input.mode === 'lift' ? resolveLift(input) : resolveTriage(input);
  return `${why}; ${email ? 'emailing' : 'no email'}`;
}

/** @param {NodeJS.ProcessEnv} env @returns {ReportInput} */
export function readInput(env) {
  const mode = env.REPORT_MODE || 'triage';
  return {
    mode,
    outcome: mode === 'triage' ? readOutcomeFile(env.OUTCOME_FILE) : { exists: false },
    agentOutcome: env.AGENT_OUTCOME ?? '',
    triageResult: env.TRIAGE_RESULT ?? '',
    gate: { outcome: env.GATE_OUTCOME ?? '', summary: env.GATE_SUMMARY ?? '', reason: env.GATE_REASON ?? '' },
    pr: { number: env.PR_NUMBER ?? '', url: env.PR_URL ?? '', title: env.PR_TITLE ?? '', headSha: env.HEAD_SHA ?? '' },
    runUrl: env.RUN_URL ?? '',
    repository: env.GITHUB_REPOSITORY ?? '',
    lift: { outcome: env.LIFT_OUTCOME ?? '', prUrl: env.LIFT_PR_URL ?? '', summary: env.LIFT_SUMMARY ?? '' },
  };
}

/** @param {unknown} text */
function oneLine(text) {
  return `${text}`.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Runs the report from the environment and resolves to the exit code: 1 when an email was due and was not
 * sent or the mode is unknown, otherwise 0. Never rejects for an expected failure; a failed comment post
 * is logged to stderr and leaves the exit code alone.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   github?: Pick<import('../lib/github.mjs').Github, 'ghApi'>,
 *   fetchImpl?: import('../lib/mandrill.mjs').Fetch,
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 *   retry?: { tries?: number, pauseMs?: number },
 * }} [deps]
 * @returns {Promise<number>}
 */
export async function run(
  env = process.env,
  {
    github = createGithub(),
    fetchImpl = fetch,
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
    retry,
  } = {},
) {
  const input = readInput(env);
  const dryRun = env.DRY_RUN === 'true';
  const heading = `renovate-doctor report${dryRun ? ' (dry run)' : ''}`;
  if (input.mode !== 'triage' && input.mode !== 'lift') {
    stderr(`${heading}: REPORT_MODE is "${input.mode}", not triage or lift; nothing reported.\n`);
    return 1;
  }

  stdout(`${heading}: ${explain(input)}.\n`);
  const message = compose(input);
  if (!message) return 0;

  stdout(`\nSubject: ${message.subject}\n\n${message.text}\n`);
  if (message.comment) stdout(`\nComment for PR #${input.pr?.number || '?'}:\n${message.comment}`);
  if (dryRun) {
    stdout('\nDry run: no email sent and no comment posted.\n');
    return 0;
  }

  let exitCode = 0;
  const missing = ['EMAIL_TO', 'EMAIL_FROM', 'MANDRILL_API_KEY'].filter((name) => !env[name]);
  if (missing.length) {
    stderr(
      `${heading}: the email was not sent because ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.\n`,
    );
    exitCode = 1;
  } else {
    // `missing` above is empty, so the three required settings are set.
    const { MANDRILL_API_KEY: apiKey, EMAIL_FROM: from, EMAIL_TO: to } = /** @type {Record<string, string>} */ (env);
    try {
      const receipt = await sendEmail(
        {
          apiKey,
          from,
          fromName: env.EMAIL_FROM_NAME || undefined,
          to,
          subject: message.subject,
          text: message.text,
        },
        fetchImpl,
        retry,
      );
      stdout(`Sent to ${to} (Mandrill status: ${receipt.status}).\n`);
    } catch (/** @type {any} */ error) {
      stderr(`${heading}: the email was not sent: ${oneLine(error?.message ?? error)}\n`);
      exitCode = 1;
    }
  }

  // The comment is posted even when the email failed: it is the PR's own record, and its marker keeps the
  // gate from escalating the same head again.
  if (message.comment) {
    const { repository, pr = {} } = input;
    if (!repository || !pr.number) {
      stderr(`${heading}: the PR comment was not posted because GITHUB_REPOSITORY or PR_NUMBER is not set.\n`);
    } else {
      try {
        const posted = github.ghApi(`repos/${repository}/issues/${pr.number}/comments`, {
          method: 'POST',
          body: { body: message.comment },
        });
        stdout(`Posted the comment on PR #${pr.number}${posted?.html_url ? `: ${posted.html_url}` : ''}.\n`);
      } catch (/** @type {any} */ error) {
        stderr(
          `${heading}: the comment on PR #${pr.number} was not posted (the email carries the news): ` +
            `${oneLine(error?.stderr || error?.message || error)}\n`,
        );
      }
    }
  }
  return exitCode;
}

const invokedDirectly =
  process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);

if (invokedDirectly) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`renovate-doctor report error:\n${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
