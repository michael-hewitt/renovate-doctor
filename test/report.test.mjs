import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { handledMarker, readMarkers } from '../scripts/gate.mjs';
import { compose, explain, formatComment, run } from '../scripts/report.mjs';

// The PR and run are crescendosw/webapp's real vite-plugin-pwa v2 failure, the same as the gate's fixtures.
const repository = 'crescendosw/webapp';
const pr = {
  number: 3814,
  url: 'https://github.com/crescendosw/webapp/pull/3814',
  title: 'chore(deps): update dependency vite-plugin-pwa to v2',
  headSha: '457ec6c5b51041158be71b2f26907c052d8fe7e9',
};
const runUrl = 'https://github.com/crescendosw/webapp/actions/runs/37993773276';
const configPr = 'https://github.com/crescendosw/webapp/pull/3890';
// Every marker in these tests is on the gate's escalation comment, so it carries that outcome: the gate
// reads it to tell a settled SHA from one that was only rerun.
const marker = '<!-- renovate-doctor sha=457ec6c5b51041158be71b2f26907c052d8fe7e9 outcome=escalated -->';

const exhaustedSummary =
  'Fix attempts exhausted: chore(deps): update dependency vite-plugin-pwa to v2 (#3814) already carries 2 commits ' +
  'by someone other than renovate[bot] (a1b2c3d, e4f5a6b), and Node.js CI still fails on 457ec6c.';

/** A valid outcome file as `readOutcomeFile` returns it. */
function file(outcome) {
  return { exists: true, parsed: { ok: true, outcome: { mention: false, links: {}, ...outcome } } };
}

function triage(overrides = {}) {
  return {
    mode: 'triage',
    outcome: { exists: false },
    agentOutcome: 'success',
    gate: { outcome: '', summary: '', reason: '' },
    pr,
    runUrl,
    repository,
    ...overrides,
  };
}

describe('compose, in triage mode', () => {
  it.each(['merged', 'rerun'])('is silent for %s without a mention', (outcome) => {
    expect(compose(triage({ outcome: file({ outcome, summary: 'Done.' }) }))).toBeUndefined();
  });

  it.each(['merged', 'rerun'])('emails for %s when the agent asks for a mention', (outcome) => {
    const message = compose(triage({ outcome: file({ outcome, summary: 'Worth knowing.', mention: true }) }));
    expect(message?.subject).toBe(`[renovate-doctor] ${outcome}: ${pr.title}`);
  });

  it.each([false, true])('is always silent for skipped, even with mention %s', (mention) => {
    const input = triage({ outcome: file({ outcome: 'skipped', summary: 'The PR was closed.', mention }) });
    expect(compose(input)).toBeUndefined();
    expect(explain(input)).toBe('skipped, from the outcome file; no email');
  });

  it.each([
    ['declined', false],
    ['declined', true],
    ['escalated', false],
    ['escalated', true],
  ])('emails for %s (mention %s)', (outcome, mention) => {
    const message = compose(triage({ outcome: file({ outcome, summary: 'Needs a person.', mention }) }));
    expect(message?.subject).toBe(`[renovate-doctor] ${outcome}: ${pr.title}`);
    expect(message?.comment).toBeUndefined();
  });

  it('writes the summary, the PR, run and config PR links, and the repository', () => {
    const summary = 'vite-plugin-pwa 2 needs vite 8 as a peer, which is not published yet; the update is on hold.';
    const message = compose(
      triage({ outcome: file({ outcome: 'declined', summary, links: { config_pr: configPr } }) }),
    );
    expect(message).toEqual({
      subject: '[renovate-doctor] declined: chore(deps): update dependency vite-plugin-pwa to v2',
      text: [
        summary,
        '',
        `PR: ${pr.url}`,
        `Run: ${runUrl}`,
        `Config PR: ${configPr}`,
        '',
        'Repository: crescendosw/webapp',
      ].join('\n'),
    });
  });

  it('leaves out the config PR line when there is none', () => {
    const message = compose(triage({ outcome: file({ outcome: 'escalated', summary: 'Needs a person.' }) }));
    expect(message?.text).toBe(`Needs a person.\n\nPR: ${pr.url}\nRun: ${runUrl}\n\nRepository: crescendosw/webapp`);
  });

  it.each(['failure', 'cancelled'])('reports a %s agent step with no outcome file as a failed run', (agentOutcome) => {
    const message = compose(triage({ agentOutcome }));
    expect(message?.subject).toBe(`[renovate-doctor] failed: ${pr.title}`);
    expect(message?.text).toMatch(/^The run failed: the agent step (failed|was cancelled) before writing an outcome/);
    expect(message?.text).toContain(`Run: ${runUrl}`);
    expect(message?.comment).toBeUndefined();
  });

  it('reports a successful agent step with no outcome file as escalated', () => {
    const message = compose(triage({ agentOutcome: 'success' }));
    expect(message?.subject).toBe(`[renovate-doctor] escalated: ${pr.title}`);
    expect(message?.text).toMatch(/^The agent wrote no outcome:/);
  });

  it('reports an agent step skipped after the gate launched (install failed) as a failed run', () => {
    const message = compose(triage({ agentOutcome: 'skipped' }));
    expect(message?.subject).toBe(`[renovate-doctor] failed: ${pr.title}`);
    expect(message?.text).toMatch(/^The run failed: the agent did not run, because a step before it/);
  });

  it('reports a malformed outcome file as a failed run, listing the problems', () => {
    const outcome = {
      exists: true,
      parsed: { ok: false, problems: ['"outcome" is "fixed"; it must be one of merged, rerun, declined, escalated'] },
    };
    const message = compose(triage({ outcome, agentOutcome: 'success' }));
    expect(message?.subject).toBe(`[renovate-doctor] failed: ${pr.title}`);
    expect(message?.text).toContain(
      'The problems with the file:\n- "outcome" is "fixed"; it must be one of merged, rerun, declined, escalated\n',
    );
  });

  it('uses the outcome file even when the agent step failed after writing it', () => {
    const message = compose(
      triage({ agentOutcome: 'failure', outcome: file({ outcome: 'declined', summary: 'On hold.' }) }),
    );
    expect(message?.subject).toBe(`[renovate-doctor] declined: ${pr.title}`);
  });

  it("emails the gate's escalation and carries the PR comment with the sha marker", () => {
    const message = compose(
      triage({
        agentOutcome: 'skipped',
        gate: { outcome: 'escalated', summary: exhaustedSummary, reason: 'attempts: fix attempts exhausted' },
      }),
    );
    expect(message?.subject).toBe(`[renovate-doctor] escalated: ${pr.title}`);
    expect(message?.text).toBe(`${exhaustedSummary}\n\nPR: ${pr.url}\nRun: ${runUrl}\n\nRepository: ${repository}`);
    expect(message?.comment).toBe(`${marker}\n**renovate-doctor**\n\nOutcome: escalated\n\n${exhaustedSummary}\n`);
    expect(message?.comment).toBe(formatComment(pr.headSha, 'escalated', exhaustedSummary));
  });

  it('names the PR by number when it has no title', () => {
    const message = compose(triage({ agentOutcome: 'failure', pr: { ...pr, title: '' } }));
    expect(message?.subject).toBe('[renovate-doctor] failed: PR #3814');
  });
});

describe('compose, in lift mode', () => {
  const lift = (overrides) => ({ mode: 'lift', runUrl, repository, lift: overrides });
  const liftPr = 'https://github.com/crescendosw/webapp/pull/3901';

  it('emails when a config PR was opened, with the summary first line as the subject', () => {
    const summary = 'Lifted 2 expired holds: vite-plugin-pwa, @types/node\nBoth dates passed on 2026-10-01.';
    expect(compose(lift({ outcome: 'opened', prUrl: liftPr, summary }))).toEqual({
      subject: '[renovate-doctor] lift: Lifted 2 expired holds: vite-plugin-pwa, @types/node',
      text: `${summary}\n\nPR: ${liftPr}\nRun: ${runUrl}\n\nRepository: ${repository}`,
    });
  });

  it('is silent when nothing had expired', () => {
    const input = lift({ outcome: 'nothing', prUrl: '', summary: '' });
    expect(compose(input)).toBeUndefined();
    expect(explain(input)).toBe('lift: nothing had expired; no email');
  });

  it('emails when the lift failed', () => {
    const message = compose(lift({ outcome: 'failure', prUrl: '', summary: '' }));
    expect(message).toEqual({
      subject: '[renovate-doctor] lift failed',
      text: `The lift run failed; the run log says where.\n\nRun: ${runUrl}\n\nRepository: ${repository}`,
    });
  });

  it('reports an outcome it does not know as a failure rather than staying silent', () => {
    const message = compose(lift({ outcome: '', prUrl: '', summary: '' }));
    expect(message?.subject).toBe('[renovate-doctor] lift failed');
    expect(message?.text).toMatch(/^The lift step reported an outcome renovate-doctor does not know \(none\)/);
  });
});

describe('run', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-doctor-report-'));

  function outcomeFile(name, content) {
    const target = path.join(temp, name);
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
    return target;
  }

  function environment(overrides = {}) {
    return {
      REPORT_MODE: 'triage',
      OUTCOME_FILE: path.join(temp, 'absent.json'),
      AGENT_OUTCOME: 'success',
      GATE_OUTCOME: '',
      GATE_SUMMARY: '',
      GATE_REASON: '',
      DRY_RUN: 'false',
      PR_NUMBER: String(pr.number),
      PR_URL: pr.url,
      PR_TITLE: pr.title,
      HEAD_SHA: pr.headSha,
      RUN_URL: runUrl,
      GITHUB_REPOSITORY: repository,
      EMAIL_TO: 'engineering@example.com',
      EMAIL_FROM: 'support@example.com',
      EMAIL_FROM_NAME: '',
      MANDRILL_API_KEY: 'test-key',
      ...overrides,
    };
  }

  function harness({ mandrill = [{ email: 'engineering@example.com', status: 'sent' }], comment } = {}) {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => mandrill }));
    const ghApi = vi.fn(
      comment ?? (() => ({ html_url: 'https://github.com/crescendosw/webapp/pull/3814#issuecomment-1' })),
    );
    const stdout = vi.fn();
    const stderr = vi.fn();
    const printed = () => stdout.mock.calls.map(([text]) => text).join('');
    const errors = () => stderr.mock.calls.map(([text]) => text).join('');
    return {
      deps: { github: { ghApi }, fetchImpl, stdout, stderr, retry: { pauseMs: 0 } },
      fetchImpl,
      ghApi,
      printed,
      errors,
    };
  }

  const sentMessage = (fetchImpl) => JSON.parse(fetchImpl.mock.calls[0][1].body).message;

  it('stays silent for a merged outcome, printing one line, and exits 0', async () => {
    const env = environment({ OUTCOME_FILE: outcomeFile('merged.json', { outcome: 'merged', summary: 'Fixed.' }) });
    const { deps, fetchImpl, ghApi, printed } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    expect(printed()).toBe('renovate-doctor report: merged, from the outcome file, with no mention; no email.\n');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ghApi).not.toHaveBeenCalled();
  });

  it('sends a declined outcome through Mandrill and exits 0', async () => {
    const env = environment({
      OUTCOME_FILE: outcomeFile('declined.json', {
        outcome: 'declined',
        summary: 'On hold until vite 8.',
        links: { config_pr: configPr },
      }),
      EMAIL_FROM_NAME: 'Sing Your Part renovate-doctor',
    });
    const { deps, fetchImpl, ghApi, printed } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    expect(sentMessage(fetchImpl)).toEqual({
      from_email: 'support@example.com',
      from_name: 'Sing Your Part renovate-doctor',
      to: [{ email: 'engineering@example.com', type: 'to' }],
      subject: `[renovate-doctor] declined: ${pr.title}`,
      text: `On hold until vite 8.\n\nPR: ${pr.url}\nRun: ${runUrl}\nConfig PR: ${configPr}\n\nRepository: ${repository}`,
    });
    expect(ghApi).not.toHaveBeenCalled();
    expect(printed()).toContain('renovate-doctor report: declined, from the outcome file; emailing.\n');
    expect(printed()).toContain('Sent to engineering@example.com (Mandrill status: sent).\n');
  });

  it('defaults the sender name when EMAIL_FROM_NAME is empty', async () => {
    const { deps, fetchImpl } = harness();
    await run(environment({ AGENT_OUTCOME: 'failure' }), deps);
    expect(sentMessage(fetchImpl).from_name).toBe('renovate-doctor');
  });

  it('emails a failed run when the agent failed without an outcome file', async () => {
    const { deps, fetchImpl, printed } = harness();
    await expect(run(environment({ AGENT_OUTCOME: 'failure' }), deps)).resolves.toBe(0);
    expect(sentMessage(fetchImpl).subject).toBe(`[renovate-doctor] failed: ${pr.title}`);
    expect(printed()).toContain(
      'renovate-doctor report: failed: the agent step concluded failure and there is no outcome file; emailing.',
    );
  });

  it('emails a failed run, naming the problems, for a malformed outcome file', async () => {
    const env = environment({ OUTCOME_FILE: outcomeFile('malformed.json', '{"outcome": "merged"') });
    const { deps, fetchImpl } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    const sent = sentMessage(fetchImpl);
    expect(sent.subject).toBe(`[renovate-doctor] failed: ${pr.title}`);
    expect(sent.text).toMatch(/\n- the file is not valid JSON/);
  });

  it("posts the gate's escalation comment with the sha marker and emails it", async () => {
    const env = environment({
      AGENT_OUTCOME: 'skipped',
      GATE_OUTCOME: 'escalated',
      GATE_SUMMARY: exhaustedSummary,
      GATE_REASON: 'attempts: 2 commits on PR #3814 are by someone other than renovate[bot]; fix attempts exhausted',
    });
    const { deps, fetchImpl, ghApi, printed } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    expect(sentMessage(fetchImpl).subject).toBe(`[renovate-doctor] escalated: ${pr.title}`);
    expect(ghApi).toHaveBeenCalledWith('repos/crescendosw/webapp/issues/3814/comments', {
      method: 'POST',
      body: { body: formatComment(pr.headSha, 'escalated', exhaustedSummary) },
    });
    expect(ghApi.mock.calls[0][1].body.body.startsWith(`${marker}\n**renovate-doctor**\n`)).toBe(true);
    expect(printed()).toContain('escalated, produced by the gate (attempts: 2 commits');
    expect(printed()).toContain('Posted the comment on PR #3814: https://github.com/crescendosw/webapp/pull/3814#');
  });

  it("emails the gate's own error but posts no comment, whose marker would silence the next triage", async () => {
    const reason = 'gate error: Command failed: gh api gh: Bad credentials (HTTP 401)';
    const summary =
      `The renovate-doctor gate failed, so the agent did not run and nothing was done on the PR: ${reason} ` +
      '(at evaluate (file:///home/runner/work/_temp/.renovate-doctor/scripts/gate.mjs:300:20)). ' +
      'The run log has the full stack.';
    const env = environment({
      AGENT_OUTCOME: 'skipped',
      GATE_OUTCOME: 'failed',
      GATE_SUMMARY: summary,
      GATE_REASON: reason,
    });
    const { deps, fetchImpl, ghApi, printed } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    const message = sentMessage(fetchImpl);
    expect(message.subject).toBe(`[renovate-doctor] failed: ${pr.title}`);
    expect(message.text.startsWith(`${summary}\n\nPR: ${pr.url}\nRun: ${runUrl}\n`)).toBe(true);
    expect(ghApi).not.toHaveBeenCalled();
    expect(printed()).toContain(`failed, produced by the gate (${reason}); the agent did not run`);
  });

  it('prints the email and the would-be comment in a dry run, and sends and posts nothing', async () => {
    const env = environment({
      DRY_RUN: 'true',
      AGENT_OUTCOME: 'skipped',
      GATE_OUTCOME: 'escalated',
      GATE_SUMMARY: exhaustedSummary,
      MANDRILL_API_KEY: '',
    });
    const { deps, fetchImpl, ghApi, printed } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ghApi).not.toHaveBeenCalled();
    const output = printed();
    expect(output).toMatch(
      /^renovate-doctor report \(dry run\): escalated, produced by the gate; the agent did not run; emailing\.\n/,
    );
    expect(output).toContain(
      `\nSubject: [renovate-doctor] escalated: ${pr.title}\n\n${exhaustedSummary}\n\nPR: ${pr.url}\n`,
    );
    expect(output).toContain(`\nComment for PR #3814:\n${marker}\n`);
    expect(output).toContain('\nDry run: no email sent and no comment posted.\n');
  });

  it('exits 1 when Mandrill refuses the email', async () => {
    const { deps, errors } = harness({ mandrill: [{ status: 'rejected', reject_reason: 'unsigned' }] });
    await expect(run(environment({ AGENT_OUTCOME: 'failure' }), deps)).resolves.toBe(1);
    expect(errors()).toMatch(/the email was not sent: Mandrill did not accept the email: .*unsigned/);
  });

  it('exits 1 when an email is due and the mail settings are missing', async () => {
    const { deps, fetchImpl, errors } = harness();
    const env = environment({ AGENT_OUTCOME: 'failure', MANDRILL_API_KEY: '', EMAIL_TO: '' });
    await expect(run(env, deps)).resolves.toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors()).toContain('the email was not sent because EMAIL_TO, MANDRILL_API_KEY are not set.');
  });

  it('still posts the comment when the email was refused, and exits 1', async () => {
    const env = environment({ AGENT_OUTCOME: 'skipped', GATE_OUTCOME: 'escalated', GATE_SUMMARY: exhaustedSummary });
    const { deps, ghApi } = harness({ mandrill: { status: 'error', message: 'Invalid API key' } });
    await expect(run(env, deps)).resolves.toBe(1);
    expect(ghApi).toHaveBeenCalledTimes(1);
  });

  it('logs a comment that could not be posted but exits 0 once the email went out', async () => {
    const env = environment({ AGENT_OUTCOME: 'skipped', GATE_OUTCOME: 'escalated', GATE_SUMMARY: exhaustedSummary });
    const failure = Object.assign(new Error('Command failed: gh api'), {
      stderr: 'gh: Resource not accessible (HTTP 403)',
    });
    const { deps, fetchImpl, errors } = harness({
      comment: () => {
        throw failure;
      },
    });
    await expect(run(env, deps)).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(errors()).toContain(
      'the comment on PR #3814 was not posted (the email carries the news): gh: Resource not accessible (HTTP 403)',
    );
  });

  it('emails an opened lift PR', async () => {
    const env = {
      ...environment(),
      REPORT_MODE: 'lift',
      LIFT_OUTCOME: 'opened',
      LIFT_PR_URL: 'https://github.com/crescendosw/webapp/pull/3901',
      LIFT_SUMMARY: 'Lifted 1 expired hold: vite-plugin-pwa',
    };
    const { deps, fetchImpl, ghApi } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    expect(sentMessage(fetchImpl).subject).toBe('[renovate-doctor] lift: Lifted 1 expired hold: vite-plugin-pwa');
    expect(ghApi).not.toHaveBeenCalled();
  });

  it('stays silent in lift mode when nothing had expired', async () => {
    const env = { ...environment(), REPORT_MODE: 'lift', LIFT_OUTCOME: 'nothing' };
    const { deps, fetchImpl, printed } = harness();
    await expect(run(env, deps)).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(printed()).toBe('renovate-doctor report: lift: nothing had expired; no email.\n');
  });

  it('emails a failed lift and exits 1 when that email is refused', async () => {
    const env = { ...environment(), REPORT_MODE: 'lift', LIFT_OUTCOME: 'failure' };
    const sent = harness();
    await expect(run(env, sent.deps)).resolves.toBe(0);
    expect(sentMessage(sent.fetchImpl).subject).toBe('[renovate-doctor] lift failed');
    const refused = harness({ mandrill: [{ status: 'invalid' }] });
    await expect(run(env, refused.deps)).resolves.toBe(1);
  });

  it('exits 1 for a REPORT_MODE it does not know', async () => {
    const { deps, fetchImpl, errors } = harness();
    await expect(run(environment({ REPORT_MODE: 'audit' }), deps)).resolves.toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors()).toContain('REPORT_MODE is "audit", not triage or lift');
  });
});

describe('formatComment', () => {
  it('starts with the marker carrying the sha and the outcome, which the gate reads back', () => {
    const comment = formatComment(pr.headSha, 'escalated', exhaustedSummary);
    expect(comment.split('\n')[0]).toBe(handledMarker(pr.headSha, 'escalated'));
    const posted = { body: comment, user: { login: 'github-actions[bot]' } };
    const { handled, rerun } = readMarkers([posted], pr.headSha);
    expect(handled).toBeDefined();
    expect(rerun).toBeUndefined();
  });
});
