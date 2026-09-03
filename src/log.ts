import { config } from './config';

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;

function emit(level: string, msg: string, meta?: unknown) {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tail = meta === undefined ? '' : ' ' + stringify(meta);
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, meta?: unknown) => emit('debug', m, meta),
  info: (m: string, meta?: unknown) => emit('info', m, meta),
  warn: (m: string, meta?: unknown) => emit('warn', m, meta),
  error: (m: string, meta?: unknown) => emit('error', m, meta),
};
