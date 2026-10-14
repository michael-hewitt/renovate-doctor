import { describe, expect, it, vi } from 'vitest';

import { createGithub } from '../lib/github.mjs';

/** @typedef {import('../lib/github.mjs').Exec} Exec */

// An error shaped like the one execFileSync throws when `gh` exits non-zero.
/** @param {string} stderr */
function ghFailure(stderr) {
  return Object.assign(new Error(`Command failed: gh api\n${stderr}`), { status: 1, stderr });
}

/**
 * A fake `exec` whose recorded calls carry the adapter's argument types.
 *
 * @param {Exec} impl
 */
function fakeExec(impl) {
  return vi.fn(impl);
}

/** @param {Exec} exec */
function fakeGithub(exec) {
  const sleep = vi.fn();
  return { ...createGithub({ exec, sleep }), sleep };
}

describe('ghApi', () => {
  it('calls `gh api` on the route and returns the parsed JSON', () => {
    const exec = fakeExec(() => '{"number":12,"state":"open"}\n');
    const { ghApi } = fakeGithub(exec);
    expect(ghApi('repos/o/r/pulls/12')).toEqual({ number: 12, state: 'open' });
    expect(exec).toHaveBeenCalledWith('gh', ['api', 'repos/o/r/pulls/12'], { input: undefined });
  });

  it('returns undefined for an empty body, such as a 204', () => {
    const { ghApi } = fakeGithub(fakeExec(() => ''));
    expect(ghApi('repos/o/r/issues/comments/1', { method: 'DELETE' })).toBeUndefined();
  });

  it('follows every page when asked, without --slurp (older gh lacks it), and joins the list pages', () => {
    // `gh api --paginate` prints the pages one after another, each a JSON text of its own.
    const exec = fakeExec(() => '[{"id":1},{"id":2}]\n[{"id":3}]\n');
    const { ghApi } = fakeGithub(exec);
    expect(ghApi('repos/o/r/pulls?per_page=100', { paginate: true })).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(exec.mock.calls[0][1]).toEqual(['api', 'repos/o/r/pulls?per_page=100', '--paginate']);
  });

  it('splits pages on brackets outside strings, so brackets and escaped quotes in bodies do not confuse it', () => {
    const pages = [[{ body: 'a ] b } c "quoted" \\ [x]' }], [{ body: '{"not":"a page"}' }]];
    const exec = fakeExec(() => pages.map((page) => JSON.stringify(page)).join(''));
    const { ghApi } = fakeGithub(exec);
    expect(ghApi('repos/o/r/issues/1/comments', { paginate: true })).toEqual(pages.flat());
  });

  it('accepts one page alone, and a pretty-printed page', () => {
    const { ghApi } = fakeGithub(fakeExec(() => '[\n  {\n    "id": 1\n  }\n]\n'));
    expect(ghApi('repos/o/r/pulls', { paginate: true })).toEqual([{ id: 1 }]);
  });

  it('joins the list inside wrapped pages, as the Actions endpoints return them', () => {
    const pages = [
      { total_count: 3, jobs: [{ id: 1 }, { id: 2 }] },
      { total_count: 3, jobs: [{ id: 3 }] },
    ];
    const { ghApi } = fakeGithub(fakeExec(() => pages.map((page) => JSON.stringify(page)).join('\n')));
    expect(ghApi('repos/o/r/actions/runs/9/jobs', { paginate: true })).toEqual({
      total_count: 3,
      jobs: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });

  it('reports malformed paginated output as a parse error rather than an empty result', () => {
    const { ghApi } = fakeGithub(fakeExec(() => 'not json'));
    expect(() => ghApi('repos/o/r/pulls', { paginate: true })).toThrow(SyntaxError);
  });

  it('does not paginate unless asked', () => {
    const exec = fakeExec(() => '[]');
    fakeGithub(exec).ghApi('repos/o/r/pulls');
    expect(exec.mock.calls[0][1]).not.toContain('--paginate');
  });

  it('sends a body as JSON on stdin, with the method', () => {
    const exec = fakeExec(() => '{"id":5}');
    const { ghApi } = fakeGithub(exec);
    const body = { body: '<!-- renovate-doctor sha=abc -->\n**renovate-doctor**', labels: ['a', 'b'] };
    expect(ghApi('repos/o/r/issues/12/comments', { method: 'POST', body })).toEqual({ id: 5 });
    const [file, args, { input }] = exec.mock.calls[0];
    expect(file).toBe('gh');
    expect(args).toEqual(['api', 'repos/o/r/issues/12/comments', '--method', 'POST', '--input', '-']);
    expect(JSON.parse(input ?? '')).toEqual(body);
  });

  it('retries a transient failure with a growing pause, then returns the answer', () => {
    const exec = vi
      .fn()
      .mockImplementationOnce(() => {
        throw ghFailure('Get "https://api.github.com/repos/o/r/pulls": read: connection timed out');
      })
      .mockImplementationOnce(() => {
        throw ghFailure('gh: Server Error (HTTP 502)');
      })
      .mockImplementationOnce(() => '[{"number":1}]');
    const { ghApi, sleep } = fakeGithub(exec);
    expect(ghApi('repos/o/r/pulls')).toEqual([{ number: 1 }]);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10_000], [20_000]]);
  });

  it('gives up after the last try and throws the last error', () => {
    const exec = vi.fn(() => {
      throw ghFailure('dial tcp: lookup api.github.com: Temporary failure in name resolution');
    });
    const { ghApi, sleep } = fakeGithub(exec);
    expect(() => ghApi('repos/o/r/pulls')).toThrow(/Temporary failure in name resolution/);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('does not retry an answer GitHub gave on purpose, such as a 404', () => {
    const exec = vi.fn(() => {
      throw ghFailure('gh: Not Found (HTTP 404)');
    });
    const { ghApi, sleep } = fakeGithub(exec);
    expect(() => ghApi('repos/o/r/pulls/999')).toThrow(/HTTP 404/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a refusal by gh itself: an unknown flag, or a response with escape sequences', () => {
    for (const stderr of [
      'unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]',
      'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway',
    ]) {
      const exec = vi.fn(() => {
        throw ghFailure(stderr);
      });
      const { gh, sleep } = fakeGithub(exec);
      expect(() => gh(['api', 'repos/o/r/actions/jobs/1/logs'])).toThrow(stderr.split('\n')[0]);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('retries a rate limit, which is a 4xx that asks to try again', () => {
    const exec = vi
      .fn()
      .mockImplementationOnce(() => {
        throw ghFailure('gh: API rate limit exceeded (HTTP 429)');
      })
      .mockImplementationOnce(() => '{}');
    expect(fakeGithub(exec).ghApi('repos/o/r')).toEqual({});
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('gh', () => {
  it('runs an arbitrary gh command and returns its stdout', () => {
    const exec = fakeExec(() => 'https://github.com/o/r/pull/7\n');
    const { gh } = fakeGithub(exec);
    expect(gh(['pr', 'merge', '7', '--auto', '--squash', '--repo', 'o/r'])).toBe('https://github.com/o/r/pull/7\n');
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'merge', '7', '--auto', '--squash', '--repo', 'o/r'], {
      input: undefined,
    });
  });

  it('retries a transient failure like ghApi does', () => {
    const exec = vi
      .fn()
      .mockImplementationOnce(() => {
        throw ghFailure('error connecting to api.github.com');
      })
      .mockImplementationOnce(() => '');
    const { gh, sleep } = fakeGithub(exec);
    expect(gh(['run', 'rerun', '9', '--failed'])).toBe('');
    expect(sleep).toHaveBeenCalledOnce();
  });
});
