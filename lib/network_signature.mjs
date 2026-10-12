// network_signature - recognise a CI failure caused by the network rather than by the code.
//
// A self-hosted runner shares its host's network, and when that network stalls a job fails on
// something that has nothing to do with the update: Docker Hub unreachable while pulling a service
// image, pnpm unable to download itself or a package's metadata, `github.com` not resolving mid-build.
// The gate uses this to leave a first-attempt network failure to the caller's rerun automation.
//
// The fragments come from real failed-job logs (crescendosw/webapp's rerun-network-failures workflow,
// where they were collected). This is the only copy of the list: scripts import it, and callers never
// duplicate it, so a new fragment added here reaches every caller with the next tag.

/** Each fragment is matched literally and case-insensitively against the failed-job log. */
const fragments = [
  'Temporary failure in name resolution',
  'Could not resolve host',
  'i/o timeout',
  'TLS handshake timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'fetch failed',
  'Failed to fetch',
  'error decoding response body',
  'Docker pull failed',
  'ERR_PNPM_BROKEN_PNPM_INSTALL',
  'ERR_PNPM_META_FETCH_FAIL',
  'ERR_PNPM_FETCH',
  'Connection timed out',
  'connection reset by peer',
  'Timed out during banner exchange',
  'The runner has received a shutdown signal',
  'lost communication with the server',
];

function escape(fragment) {
  return fragment.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The network-failure signature: any one fragment, case-insensitive. */
export const networkSignature = new RegExp(fragments.map(escape).join('|'), 'i');

/**
 * The first network-failure fragment in `logText`, as it appears in the log, or undefined when the
 * log shows no sign of the network (the failure is in the code, or there is no log).
 *
 * @param {string | undefined} logText
 * @returns {string | undefined}
 */
export function matchNetworkSignature(logText) {
  if (!logText) return undefined;
  return networkSignature.exec(logText)?.[0];
}
