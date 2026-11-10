import { secret } from '../../../b/src/internal/secret.js';
import adapter from '@qos/adapters-github';
import { x } from '../../../../../apps/api/src/x.js';
export const use = [secret, adapter, x];
