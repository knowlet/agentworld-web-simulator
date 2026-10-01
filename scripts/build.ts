import { mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/assets', { recursive: true });

// BASE_PATH decides the URL prefix baked into index.html and the app bundle:
//   default '/'           → local Bun server (this repo's own static serving)
//   '/<repo-name>/'       → GitHub Pages project site (set by the deploy workflow)
function normalizeBase(raw: string | undefined): string {
  let base = (raw ?? '/').trim() || '/';
  if (!base.startsWith('/')) base = '/' + base;
  if (!base.endsWith('/')) base += '/';
  if (base.includes('..') || base.includes('//')) throw new Error(`Invalid BASE_PATH: ${raw}`);
  return base;
}
const base = normalizeBase(process.env.BASE_PATH);

const result = await Bun.build({
  entrypoints: ['ui/App.tsx'],
  outdir: 'dist/assets',
  target: 'browser',
  format: 'esm',
  minify: true,
  naming: 'app.[ext]',
  define: {
    'process.env.NODE_ENV': '"production"',
    __BASE__: JSON.stringify(base),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('Bun.build failed');
}

const html = (await Bun.file('ui/index.html').text()).replaceAll('"/assets/', `"${base}assets/`);
await Bun.write('dist/index.html', html);
console.log(`built with BASE_PATH=${base}`);
