/**
 * Build: bundles src/main.ts and copies the page and stylesheet into the Python package so the
 * app runs without Node. Pass --watch to rebuild on changes.
 *
 * License: BSD 3-Clause
 */
import {copyFileSync, mkdirSync} from 'node:fs';
import * as esbuild from 'esbuild';

const OUT = '../src/financial_planner/web';
const WATCH = process.argv.includes('--watch');

mkdirSync(OUT, {recursive: true});
copyFileSync('src/index.html', `${OUT}/index.html`);
copyFileSync('src/app.css', `${OUT}/app.css`);
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: `${OUT}/app.js`,
  legalComments: 'none',
  logLevel: 'info',
};
if (WATCH) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
