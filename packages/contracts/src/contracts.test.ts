import { describe, expect, it } from 'vitest';
import { CreateProbeRequest, EventEnvelope, exportJsonSchemas } from './index.js';

describe('contracts', () => {
  it('trims and bounds the probe label', () => {
    expect(CreateProbeRequest.parse({ label: '  hi ' }).label).toBe('hi');
    expect(CreateProbeRequest.safeParse({ label: '' }).success).toBe(false);
    expect(CreateProbeRequest.safeParse({ label: 'x'.repeat(201) }).success).toBe(false);
  });

  it('requires dotted lower-case event types', () => {
    const base = {
      eventId: '0190a5e0-7c1a-7000-8000-000000000001',
      aggregateType: 'probe',
      aggregateId: 'a',
      projectId: null,
      occurredAt: new Date().toISOString(),
      correlationId: null,
      payload: {},
    };
    expect(EventEnvelope.safeParse({ ...base, type: 'platform.probe.created' }).success).toBe(true);
    expect(EventEnvelope.safeParse({ ...base, type: 'ProbeCreated' }).success).toBe(false);
  });

  it('exports a JSON Schema for every registered contract', () => {
    const schemas = exportJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      'ApiError',
      'CreateProbeRequest',
      'EventEnvelope',
      'HealthResponse',
      'OperationResponse',
      'ProbeResponse',
    ]);
    expect(schemas.CreateProbeRequest).toMatchObject({ type: 'object' });
  });
});
