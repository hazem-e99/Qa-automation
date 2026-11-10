import type { QueueDefinition } from '@qos/ports';

const defaults = {
  retryLimit: 5,
  retryDelaySeconds: 5,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
} as const;

/**
 * Queue registry: every queue the system uses is declared here with its policy (doc 12).
 * Modules add their queues as they are built; nothing sends to an undeclared queue.
 */
export const QUEUES = {
  deadLetter: { name: 'platform.dead-letter', policy: 'standard', ...defaults, retryLimit: 0 },
  probeProcess: {
    name: 'platform.probe.process',
    policy: 'standard',
    ...defaults,
    deadLetter: 'platform.dead-letter',
  },
} as const satisfies Record<string, QueueDefinition>;

export const ALL_QUEUES: readonly QueueDefinition[] = Object.values(QUEUES);
