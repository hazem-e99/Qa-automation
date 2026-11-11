import type { INestApplication } from '@nestjs/common';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { ACCESS_METADATA, type Access } from './access.js';

export interface RouteEntry {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly access: Access | null;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/**
 * Lists every HTTP route handler registered in the application together with its access
 * declaration (M13-AC-01). `access` is null for a handler that declares nothing.
 */
export function listRoutes(app: INestApplication): RouteEntry[] {
  const scanner = new MetadataScanner();
  const routes: RouteEntry[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const instance = wrapper.instance as object | null;
      if (!instance) continue;
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      const base = String(Reflect.getMetadata('path', instance.constructor) ?? '');
      for (const name of scanner.getAllMethodNames(proto)) {
        const fn = proto[name] as object;
        const path = Reflect.getMetadata('path', fn) as string | string[] | undefined;
        const method = Reflect.getMetadata('method', fn) as number | undefined;
        if (path === undefined || method === undefined) continue; // not a route handler
        routes.push({
          controller: instance.constructor.name,
          handler: name,
          method: METHODS[method] ?? String(method),
          path: `/${[base, Array.isArray(path) ? path[0] : path].filter((p) => p && p !== '/').join('/')}`,
          access: (Reflect.getMetadata(ACCESS_METADATA, fn) as Access | undefined) ?? null,
        });
      }
    }
  }
  return routes;
}
