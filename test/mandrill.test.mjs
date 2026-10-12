import { describe, expect, it, vi } from 'vitest';

import { sendEmail } from '../lib/mandrill.mjs';

const message = {
  apiKey: 'test-key',
  from: 'support@example.com',
  fromName: 'renovate-doctor',
  to: 'engineering@example.com',
  subject: '[renovate-doctor] declined: chore(deps): update dependency vite-plugin-pwa to v2',
  text: 'vite-plugin-pwa 2 needs vite 8, which is not out yet.',
};

// No pause between tries, so the retry test does not wait ten seconds.
const noPause = { pauseMs: 0 };

function respondWith(result, status = 200) {
  return vi.fn(async () => ({ status, json: async () => result }));
}

describe('sendEmail', () => {
  it('posts the message to Mandrill and returns the receipt when it is accepted', async () => {
    const fetchImpl = respondWith([{ email: 'engineering@example.com', status: 'sent', _id: 'abc' }]);
    const receipt = await sendEmail(message, fetchImpl, noPause);
    expect(receipt).toEqual({ email: 'engineering@example.com', status: 'sent', _id: 'abc' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://mandrillapp.com/api/1.0/messages/send.json');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      key: 'test-key',
      message: {
        from_email: 'support@example.com',
        from_name: 'renovate-doctor',
        to: [{ email: 'engineering@example.com', type: 'to' }],
        subject: message.subject,
        text: message.text,
      },
    });
  });

  it.each(['queued', 'scheduled'])('accepts a %s message', async (status) => {
    const fetchImpl = respondWith([{ email: 'engineering@example.com', status }]);
    await expect(sendEmail(message, fetchImpl, noPause)).resolves.toMatchObject({ status });
  });

  it('names the sender renovate-doctor when no display name is given', async () => {
    const fetchImpl = respondWith([{ status: 'sent' }]);
    await sendEmail({ ...message, fromName: undefined }, fetchImpl, noPause);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).message.from_name).toBe('renovate-doctor');
  });

  it('throws with the response when Mandrill rejects the message', async () => {
    const fetchImpl = respondWith([
      { email: 'engineering@example.com', status: 'rejected', reject_reason: 'unsigned' },
    ]);
    await expect(sendEmail(message, fetchImpl, noPause)).rejects.toThrow(/did not accept.*rejected.*unsigned/);
  });

  it('throws with the response when Mandrill answers with an error object', async () => {
    const fetchImpl = respondWith({ status: 'error', code: -1, name: 'Invalid_Key', message: 'Invalid API key' }, 500);
    await expect(sendEmail(message, fetchImpl, noPause)).rejects.toThrow(/Invalid API key/);
  });

  it('throws a readable error when the response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    await expect(sendEmail(message, fetchImpl, noPause)).rejects.toThrow(/HTTP 502/);
  });

  it('tries again when the fetch itself fails, and sends once it gets through', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ status: 200, json: async () => [{ status: 'queued' }] });
    await expect(sendEmail(message, fetchImpl, noPause)).resolves.toMatchObject({ status: 'queued' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last try and throws the fetch error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(sendEmail(message, fetchImpl, { tries: 3, pauseMs: 0 })).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
