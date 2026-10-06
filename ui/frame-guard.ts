/** Fail closed before mounting App: no settings load, effects or providers. */
export function isEmbedded(scope: { readonly self: unknown; readonly top: unknown }): boolean {
  try { return scope.self !== scope.top; }
  catch { return true; }
}
