// mandrill - send one plain-text email through Mandrill's send API.
//
// The report step is the only caller. The mail provider sits behind this one function so a second
// provider can be added beside it with the same arguments. The API key comes from the caller's
// MANDRILL_API_KEY secret, which the report step reads and the agent step never sees.
//
// A refused message throws: the email is what a non-merged run produces, so a send that did not
// happen must fail the step visibly rather than pass quietly.

/**
 * The part of `fetch` the sender uses; `fetch` itself is one, and tests pass a fake.
 *
 * @typedef {{ method: string, headers: Record<string, string>, body: string }} FetchInit
 * @typedef {(url: string, init: FetchInit) => Promise<{ status: number, json: () => Promise<any> }>} Fetch
 * @typedef {{ email: string, status: string, _id?: string, reject_reason?: string }} Receipt
 *   Mandrill's answer for one recipient.
 */

const sendUrl = 'https://mandrillapp.com/api/1.0/messages/send.json';

// Mandrill's per-recipient statuses that mean the message is on its way.
const acceptedStatuses = ['sent', 'queued', 'scheduled'];

/**
 * A self-hosted runner's network can stall for seconds, so a fetch that throws (no response at all)
 * is tried again after a growing pause. A response, even a refusal, is final.
 *
 * @param {Fetch} fetchImpl
 * @param {string} url
 * @param {FetchInit} init
 * @param {{ tries: number, pauseMs: number }} retry
 */
async function fetchWithRetries(fetchImpl, url, init, { tries, pauseMs }) {
  for (let i = 1; ; i += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (i >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, pauseMs * i));
    }
  }
}

/**
 * Sends the message and returns Mandrill's receipt for the recipient, or throws with Mandrill's
 * response when it was not accepted.
 *
 * @param {{ apiKey: string, from: string, fromName?: string, to: string, subject: string, text: string }} message
 * @param {Fetch} [fetchImpl]
 * @param {{ tries?: number, pauseMs?: number }} [retry] tests pass a pause of 0
 * @returns {Promise<Receipt>}
 */
export async function sendEmail(
  { apiKey, from, fromName = 'renovate-doctor', to, subject, text },
  fetchImpl = fetch,
  { tries = 4, pauseMs = 10_000 } = {},
) {
  const response = await fetchWithRetries(
    fetchImpl,
    sendUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: apiKey,
        message: {
          from_email: from,
          from_name: fromName,
          to: [{ email: to, type: 'to' }],
          subject,
          text,
        },
      }),
    },
    { tries, pauseMs },
  );
  // A gateway error arrives as an HTML page, not JSON; say so rather than surfacing a parse error.
  const result = await response.json().catch(() => `HTTP ${response.status} with a body that is not JSON`);
  const receipt = Array.isArray(result) ? result[0] : undefined;
  if (!receipt || !acceptedStatuses.includes(receipt.status)) {
    throw new Error(`Mandrill did not accept the email: ${JSON.stringify(result)}`);
  }
  return receipt;
}
