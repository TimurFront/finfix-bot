import fs from 'node:fs';
import path from 'node:path';

/**
 * Минимальный загрузчик .env — чтобы у проекта не было ни одной
 * runtime-зависимости. Уже заданные переменные окружения не перезаписываются.
 */
export function loadEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // снимаем обрамляющие кавычки, если они есть
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
