import { z } from 'zod';
import { ApiError } from './common.js';
import { EventEnvelope } from './events.js';
import { HealthResponse } from './health.js';
import { CreateProbeRequest, ProbeResponse } from './probe.js';

/** Registry of exported contracts. OpenAPI assembly on top of this arrives with the first product API (P2). */
export const contractRegistry = {
  ApiError,
  EventEnvelope,
  HealthResponse,
  CreateProbeRequest,
  ProbeResponse,
} as const;

export function exportJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(contractRegistry).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]),
  );
}
