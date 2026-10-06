declare const __BASE__: string;
export const BASE = typeof __BASE__ === 'string' ? __BASE__ : '/';
/** Translate a validated logical simulator route at the DOM boundary only. */
export function absoluteFor(href: string, base = BASE): string {
  if (!(href === '/' || href.startsWith('/view?') || href.startsWith('/search?'))) {
    throw new Error('Invalid simulator route');
  }
  return base + href.slice(1);
}
