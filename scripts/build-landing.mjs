#!/usr/bin/env node
/**
 * Regenera los bundles publicados en landing/ (Cloudflare Pages sirve landing/ tal cual):
 *   bandait-follower   -> landing/app
 *   bandait-leader-web -> landing/hub
 *
 * Uso (desde la raiz):  npm run build:landing            # ambos
 *                       npm run build:landing -- app     # solo el follower
 *                       npm run build:landing -- hub     # solo el hub
 *
 * Borra en el destino solo lo que el build regenera (assets/ con hash, sw.js, workbox-*.js,
 * index.html, manifiestos) y conserva lo que no viene del build (iconos, favicon).
 * Las variables VITE_* se toman del entorno o de los .env de cada paquete al compilar.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const targets = {
  app: { pkg: 'bandait-follower', dest: 'landing/app' },
  hub: { pkg: 'bandait-leader-web', dest: 'landing/hub' },
};

const requested = process.argv.slice(2).filter((a) => a in targets);
const selected = requested.length > 0 ? requested : Object.keys(targets);

for (const name of selected) {
  const { pkg, dest } = targets[name];
  const pkgDir = join(root, pkg);
  const distDir = join(pkgDir, 'dist');
  const destDir = join(root, dest);

  console.log(`\n[build-landing] ${pkg} -> ${dest}`);
  execSync('npm run build', { cwd: pkgDir, stdio: 'inherit' });

  if (!existsSync(join(distDir, 'index.html'))) {
    throw new Error(`${pkg}: el build no produjo dist/index.html`);
  }

  // Limpiar solo artefactos regenerables para no dejar bundles viejos con hash.
  for (const entry of readdirSync(destDir)) {
    if (
      entry === 'assets' ||
      entry === 'index.html' ||
      entry === 'sw.js' ||
      entry === 'registerSW.js' ||
      entry === 'manifest.webmanifest' ||
      /^workbox-.*\.js$/.test(entry)
    ) {
      rmSync(join(destDir, entry), { recursive: true, force: true });
    }
  }

  cpSync(distDir, destDir, { recursive: true });
  console.log(`[build-landing] ${dest} actualizado`);
}
