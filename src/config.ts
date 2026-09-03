import { loadEnv } from './env';

loadEnv();

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== undefined ? n : fallback;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',

  /** ID приватной супергруппы с включёнными темами. Отрицательное число вида -1001234567890. */
  groupId: int(process.env.GROUP_ID, 0),

  /**
   * 'polling' — бот сам опрашивает Telegram. Подходит и для локальной работы,
   *             и для production на маленьком объёме. Публичный адрес не нужен.
   * 'webhook' — Telegram стучится к нам сам. Нужен https-адрес.
   */
  mode: (process.env.MODE ?? 'polling') as 'polling' | 'webhook',

  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  webhookSecretPath: process.env.WEBHOOK_SECRET_PATH ?? '',
  webhookSecretToken: process.env.WEBHOOK_SECRET_TOKEN ?? '',

  dbFile: process.env.DB_FILE ?? './data/relay.db',

  /**
   * Необязательный текст, который бот отправит клиенту в ответ на /start.
   * По умолчанию пусто — бот не пишет клиенту ничего сам.
   * Это единственное автоматическое сообщение во всей системе, и оно выключено.
   */
  welcomeText: process.env.WELCOME_TEXT ?? '',

  /** Базовый адрес Bot API. Подменяется только в тестах. */
  apiBase: process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org',

  /** Ставить ли реакцию на сообщение оператора после успешной доставки. */
  confirmWithReaction: bool(process.env.CONFIRM_WITH_REACTION, true),

  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export type Config = typeof config;
