export type Result<T, E = DomainError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Errors carry a stable code plus params. The API returns codes, never localized strings (doc 20 §9). */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly params: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(code);
    this.name = 'DomainError';
  }
}
