import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Сборка только лендинга — для постоянного хостинга витрины.
 *
 * Отдельный конфиг, а не флаг у основного: у лендинга другой вход
 * (`landing.html`), другой каталог вывода (`dist-landing`) и нет прокси на API —
 * статике он не нужен, все переходы в кабинет идут на `VITE_APP_URL`.
 *
 *   pnpm --filter web build:landing
 *   VITE_APP_URL=https://app.skillwharf.ru pnpm --filter web build:landing
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url));
const outDir = join(rootDir, 'dist-landing');

/**
 * Хостинг ищет точку входа в `index.html`, а Vite называет файл по имени
 * входа (`landing.html`). Переименовываем после сборки, чтобы каталог
 * `dist-landing` можно было залить в корень сайта как есть.
 */
function indexEntryPlugin(): Plugin {
  return {
    name: 'landing-index-entry',
    closeBundle() {
      const from = join(outDir, 'landing.html');
      const to = join(outDir, 'index.html');
      if (existsSync(from)) {
        renameSync(from, to);
      }
    },
  };
}

export default defineConfig({
  root: rootDir,
  plugins: [react(), tailwindcss(), indexEntryPlugin()],
  build: {
    outDir: 'dist-landing',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./landing.html', import.meta.url)),
    },
  },
});
