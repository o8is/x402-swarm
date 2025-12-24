import * as esbuild from 'esbuild';
import { watch } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);

const options = {
  entryPoints: [`${rootDir}/ui/index.ts`],
  bundle: true,
  outfile: `${rootDir}/public/ui.js`,
  platform: 'browser',
  target: 'es2020',
  format: 'esm',
  external: [],
  sourcemap: false,
  minify: false,
};

export async function buildUI() {
  try {
    console.log('Building UI...');
    await esbuild.build(options);
    console.log('UI built successfully to public/ui.js');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

export async function watchUI() {
  const ctx = await esbuild.context(options);
  console.log('Watching UI files...');
  await ctx.watch();
}

// If called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildUI();
}
