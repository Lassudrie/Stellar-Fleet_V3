import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'dist', 'viewer');
const publicDir = path.join(rootDir, 'public');
const entryPoint = path.join(rootDir, 'src', 'client', 'index.ts');

const copyPublic = async () => {
  await mkdir(outDir, { recursive: true });
  await cp(publicDir, outDir, { recursive: true });
};

const mode = process.argv[2] ?? 'build';
const isDev = mode === 'dev';

const buildOptions = {
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: path.join(outDir, 'client.js'),
  sourcemap: isDev,
  minify: !isDev,
  logLevel: 'info'
};

const run = async () => {
  await copyPublic();

  if (isDev) {
    const ctx = await context(buildOptions);
    await ctx.watch();
    const server = await ctx.serve({ servedir: outDir, port: 5173 });
    console.log(`[viewer] http://${server.host}:${server.port}`);
    return;
  }

  await build(buildOptions);
};

run().catch(error => {
  console.error('[viewer] build failed', error);
  process.exitCode = 1;
});
