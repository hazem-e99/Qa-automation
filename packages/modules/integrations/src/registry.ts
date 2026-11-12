import {
  CapabilityMissingError,
  isCatalogCapability,
  type CapabilityId,
  type CapabilityManifest,
  type ProviderAdapter,
} from '@qos/ports';

/**
 * Provider registry (doc 11 §4): the adapters this installation knows, keyed by provider type.
 * Composition roots register adapters; core code only ever sees the port types.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    const m = adapter.manifest();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(m.providerType))
      throw new Error(`invalid provider type: ${m.providerType}`);
    if (this.adapters.has(m.providerType))
      throw new Error(`provider type registered twice: ${m.providerType}`);
    // Manifest honesty starts here: only catalog capabilities of the adapter's own family.
    const foreign = m.capabilities.filter((c) => !isCatalogCapability(m.family, c));
    if (foreign.length)
      throw new Error(`${m.providerType} declares unknown capabilities: ${foreign.join(', ')}`);
    this.adapters.set(m.providerType, adapter);
    return this;
  }

  has(providerType: string): boolean {
    return this.adapters.has(providerType);
  }

  get(providerType: string): ProviderAdapter {
    const a = this.adapters.get(providerType);
    if (!a) throw new Error(`unknown provider type: ${providerType}`);
    return a;
  }

  /** Typed access with a capability check: throws CapabilityMissingError, never fails silently. */
  require<T extends ProviderAdapter>(providerType: string, capabilities: readonly CapabilityId[]): T {
    const adapter = this.get(providerType);
    const declared = new Set(adapter.manifest().capabilities);
    const missing = capabilities.filter((c) => !declared.has(c));
    if (missing.length) throw new CapabilityMissingError(missing);
    return adapter as T;
  }

  catalog(): CapabilityManifest[] {
    return [...this.adapters.values()]
      .map((a) => a.manifest())
      .sort((a, b) => a.providerType.localeCompare(b.providerType));
  }
}
