import { describe, expect, it } from 'vitest';

import { matchNetworkSignature, networkSignature } from '../lib/network_signature.mjs';

// Failed-job logs as GitHub serves them, trimmed to the lines around the failure. The first four are
// real: crescendosw/webapp runs 37159829195 (pnpm unable to download itself), 37186036029 (a preview
// teardown's Cloudflare call) and 37173840944 (a `gh api` call stalling). The others are in the exact
// form the tool prints, for the signatures whose original logs GitHub no longer keeps.
/** @type {Record<string, string[]>} */
const networkLogs = {
  'pnpm self-install timing out': [
    '2026-10-04T00:50:30.1498973Z Switching pnpm from v11.19.0 to v12.8.2...',
    '2026-10-04T00:50:33.3314106Z [WARN] GET https://registry.npmjs.org/pnpm error (ETIMEDOUT). Will retry in 10 seconds. 2 retries left.',
    '2026-10-04T00:52:26.1077374Z [WARN] GET https://registry.npmjs.org/pnpm/-/pnpm-12.8.2.tgz error (23). Will retry in 10 seconds. 2 retries left.',
    '2026-10-04T00:54:53.0673429Z [ERR_PNPM_BROKEN_PNPM_INSTALL] The pnpm v12.8.2 that was just installed cannot run: it exited with code 1: Downloading the pnpm 12.8.2 binary for linux-x64...',
    '2026-10-04T00:54:53.0693598Z Could not download the pnpm 12.8.2 binary: Could not reach https://registry.npmjs.org/@pnpm/exe.linux-x64/12.8.2: fetch failed',
    '2026-10-04T00:54:53.1213955Z ##[error]Something went wrong, self-installer exits with code 1',
  ],
  'a script whose fetch failed': [
    '2026-10-04T10:36:05.7279558Z ##[group]Run node scripts/preview-dns.mjs delete',
    '2026-10-04T10:36:05.7304055Z ##[endgroup]',
    '2026-10-04T10:36:16.3087046Z [preview-dns] FAILED: fetch failed',
    '2026-10-04T10:36:18.9924788Z ##[error]Process completed with exit code 1.',
  ],
  'gh api stalling on a read': [
    '2026-10-04T04:49:27.8192447Z ##[group]Run node scripts/sweep-digest.mjs',
    '2026-10-04T04:55:45.7282119Z Get "https://api.github.com/repos/crescendosw/webapp/pulls?state=open&sort=created&direction=desc&per_page=100": read tcp 192.168.68.60:55902->20.29.134.17:443: read: connection timed out',
    '2026-10-04T04:55:45.7370487Z ##[error]Process completed with exit code 1.',
  ],
  'pnpm unable to fetch package metadata': [
    '2026-10-03T22:14:08.4410021Z Progress: resolved 412, reused 398, downloaded 0, added 0',
    '2026-10-03T22:14:41.0021387Z  ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/vite-plugin-pwa: request to https://registry.npmjs.org/vite-plugin-pwa failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org',
    '2026-10-03T22:14:41.0412290Z ##[error]Process completed with exit code 1.',
  ],
  'git unable to resolve github.com': [
    '2026-10-03T22:02:11.2190334Z [command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +refs/heads/renovate/vite-plugin-pwa-2.x*:refs/remotes/origin/renovate/vite-plugin-pwa-2.x*',
    "2026-10-03T22:02:31.3301184Z fatal: unable to access 'https://github.com/crescendosw/webapp/': Could not resolve host: github.com",
    "2026-10-03T22:02:31.3317735Z The process '/usr/bin/git' failed with exit code 128",
  ],
  'Docker unable to resolve the registry': [
    '2026-10-03T22:05:40.1182911Z ##[command]/usr/bin/docker pull postgres:17',
    '2026-10-03T22:06:00.1290112Z Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: Temporary failure in name resolution',
    '2026-10-03T22:06:00.1311854Z ##[warning]Docker pull failed with exit code 1, back off 3.62 seconds before retry.',
  ],
  'Docker timing out on the TLS handshake': [
    '2026-10-03T22:07:12.5512033Z ##[command]/usr/bin/docker pull postgres:17',
    '2026-10-03T22:07:22.5603487Z Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout',
  ],
};

// Failures in the code, which must be left to the agent: a real vitest assertion (webapp run
// 37136304772) and a real `tsc` error from an update that changed a type (webapp run 37082755088).
/** @type {Record<string, string[]>} */
const codeLogs = {
  'a vitest assertion': [
    '2026-10-03T16:42:31.8555654Z  FAIL   client  src/pages/learn/solfege/test/sing_in_solfege_page.test.tsx > a session > "Back to Pitch" on the summary leaves for the Pitch class screen',
    '2026-10-03T16:42:31.8557992Z AssertionError: expected null not to be null',
    '2026-10-03T16:42:31.8559567Z  ❯ byId src/pages/learn/solfege/test/sing_in_solfege_page.test.tsx:208:23',
    '2026-10-03T16:42:31.8563143Z     207|   const element = document.getElementById(id);',
    '2026-10-03T16:42:31.8564859Z     208|   expect(element).not.toBeNull();',
    '2026-10-03T16:42:31.8566092Z        |                       ^',
  ],
  'a tsc error': [
    "2026-10-03T00:38:15.8300294Z ##[error].storybook/preview.tsx(18,9): error TS2353: Object literal may only specify known properties, and 'onUnhandledRequest' does not exist in type 'StartOptions'.",
    "2026-10-03T00:38:15.8321892Z ##[error].storybook/preview.tsx(18,28): error TS7006: Parameter 'req' implicitly has an 'any' type.",
    '2026-10-03T00:38:15.8410552Z ##[error]Process completed with exit code 2.',
  ],
};

describe('matchNetworkSignature', () => {
  it.each([
    ['pnpm self-install timing out', 'ETIMEDOUT'],
    ['a script whose fetch failed', 'fetch failed'],
    ['gh api stalling on a read', 'connection timed out'],
    ['pnpm unable to fetch package metadata', 'ERR_PNPM_META_FETCH_FAIL'],
    ['git unable to resolve github.com', 'Could not resolve host'],
    ['Docker unable to resolve the registry', 'Temporary failure in name resolution'],
    ['Docker timing out on the TLS handshake', 'TLS handshake timeout'],
  ])('recognises %s', (name, fragment) => {
    expect(matchNetworkSignature(networkLogs[name].join('\n'))).toBe(fragment);
  });

  it.each(Object.keys(codeLogs))('leaves %s alone', (name) => {
    expect(matchNetworkSignature(codeLogs[name].join('\n'))).toBeUndefined();
  });

  it('returns the fragment as the log spells it, ignoring case', () => {
    expect(matchNetworkSignature('read: Connection Reset By Peer')).toBe('Connection Reset By Peer');
  });

  it('treats an empty or missing log as no network failure', () => {
    expect(matchNetworkSignature('')).toBeUndefined();
    expect(matchNetworkSignature(undefined)).toBeUndefined();
  });

  it('matches fragments literally, so a slash or a dot in one is not a pattern', () => {
    expect(networkSignature.test('i/o timeout')).toBe(true);
    expect(networkSignature.test('iXo timeout')).toBe(false);
  });
});
