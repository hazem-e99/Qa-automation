import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyDelivery } from './webhooks.js';

const hook = { verification: 'hmac_sha256' as const, signatureHeader: 'x-sig', deliveryIdHeader: 'x-id' };
const body = new TextEncoder().encode('{"action":"opened"}');
const sign = (secret: string, b: Uint8Array) => createHmac('sha256', secret).update(b).digest('hex');

describe('verifyDelivery', () => {
  it('accepts a correct HMAC with or without the sha256= prefix, case-insensitive hex', () => {
    const sig = sign('s3cret', body);
    expect(verifyDelivery('hmac_sha256', hook, 's3cret', { 'x-sig': `sha256=${sig}` }, body)).toEqual({
      ok: true,
    });
    expect(verifyDelivery('hmac_sha256', hook, 's3cret', { 'x-sig': sig.toUpperCase() }, body)).toEqual({
      ok: true,
    });
  });

  it('rejects a wrong secret, a changed body, a missing or malformed signature', () => {
    const sig = sign('s3cret', body);
    expect(verifyDelivery('hmac_sha256', hook, 'other', { 'x-sig': sig }, body)).toMatchObject({
      reason: 'signature_mismatch',
    });
    const tampered = new TextEncoder().encode('{"action":"closed"}');
    expect(verifyDelivery('hmac_sha256', hook, 's3cret', { 'x-sig': sig }, tampered)).toMatchObject({
      ok: false,
    });
    expect(verifyDelivery('hmac_sha256', hook, 's3cret', {}, body)).toMatchObject({
      reason: 'signature_missing',
    });
    expect(verifyDelivery('hmac_sha256', hook, 's3cret', { 'x-sig': 'sha256=zz' }, body)).toMatchObject({
      reason: 'signature_malformed',
    });
  });

  it('checks shared tokens and basic auth in constant time', () => {
    const tokenHook = { verification: 'shared_token' as const, signatureHeader: 'x-token' };
    expect(verifyDelivery('shared_token', tokenHook, 'tok', { 'x-token': 'tok' }, body)).toEqual({
      ok: true,
    });
    expect(verifyDelivery('shared_token', tokenHook, 'tok', { 'x-token': 'tok2' }, body)).toMatchObject({
      ok: false,
    });
    const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    const basicHook = { verification: 'basic_auth' as const };
    expect(
      verifyDelivery('basic_auth', basicHook, 'pw', { authorization: basic('qos', 'pw') }, body),
    ).toEqual({ ok: true });
    expect(
      verifyDelivery('basic_auth', basicHook, 'pw', { authorization: basic('qos', 'nope') }, body),
    ).toMatchObject({
      ok: false,
    });
    expect(verifyDelivery('basic_auth', basicHook, 'pw', { authorization: 'Bearer pw' }, body)).toMatchObject(
      {
        reason: 'basic_missing',
      },
    );
  });
});
