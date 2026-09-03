import { config } from './config';
import { log } from './log';

/* ------------------------------- типы Telegram ------------------------------ */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_forum?: boolean;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  contact?: { phone_number: string; user_id?: number };
  reply_to_message?: TgMessage;
  /** служебные сообщения форума — их пересылать не надо */
  forum_topic_created?: unknown;
  forum_topic_edited?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
  pinned_message?: unknown;
  [k: string]: unknown;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  [k: string]: unknown;
}

/* --------------------------------- ошибки ---------------------------------- */

export class TelegramError extends Error {
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;

  constructor(code: number, description: string, retryAfter?: number) {
    super(`Telegram ${code}: ${description}`);
    this.name = 'TelegramError';
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }

  /** Повторять бессмысленно: бот заблокирован, чат не найден, битый запрос. */
  get permanent(): boolean {
    if (this.code === 429 || this.code >= 500) return false;
    return this.code === 400 || this.code === 401 || this.code === 403;
  }

  /** Топик удалён вручную — надо создать заново. */
  get topicGone(): boolean {
    const d = this.description.toLowerCase();
    return (
      d.includes('message thread not found') ||
      d.includes('topic_deleted') ||
      d.includes('thread not found')
    );
  }

  /** Понятная оператору формулировка. */
  get human(): string {
    const d = this.description.toLowerCase();
    if (d.includes('bot was blocked')) return 'клиент заблокировал бота';
    if (d.includes('user is deactivated')) return 'аккаунт клиента удалён';
    if (d.includes('chat not found')) return 'чат не найден';
    if (d.includes("can't be copied") || d.includes('message can not be copied'))
      return 'такое сообщение Telegram не разрешает пересылать';
    if (d.includes('not enough rights') || d.includes('need administrator rights'))
      return 'у бота не хватает прав в группе';
    if (this.code === 401) return 'неверный токен бота';
    return this.description;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/* ------------------------------- вызов метода ------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Не чаще ~1 сообщения в секунду в один чат — лимит Telegram. */
const lastSendPerChat = new Map<number, number>();

async function throttle(chatId: number | undefined) {
  if (chatId === undefined) return;
  const now = Date.now();
  const wait = (lastSendPerChat.get(chatId) ?? 0) + 1000 - now;
  if (wait > 0) await sleep(wait);
  lastSendPerChat.set(chatId, Date.now());

  if (lastSendPerChat.size > 2000) {
    const cutoff = Date.now() - 120_000;
    for (const [k, v] of lastSendPerChat) if (v < cutoff) lastSendPerChat.delete(k);
  }
}

const MAX_ATTEMPTS = 4;

/**
 * Вызов метода Bot API. Внутри уже есть повторы для 429 и 5xx —
 * отдельная очередь и воркер для такого объёма не нужны.
 */
export async function call<T = any>(
  method: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number; attempts?: number; throttleChat?: number } = {},
): Promise<T> {
  if (!config.botToken) throw new TelegramError(401, 'TELEGRAM_BOT_TOKEN не задан');

  const maxAttempts = opts.attempts ?? MAX_ATTEMPTS;
  const url = `${config.apiBase}/bot${config.botToken}/${method}`;

  for (let attempt = 1; ; attempt++) {
    if (opts.throttleChat !== undefined) await throttle(opts.throttleChat);

    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      const netErr = new NetworkError(
        err?.name === 'AbortError' ? 'таймаут запроса к Telegram' : String(err?.message ?? err),
      );
      if (attempt >= maxAttempts) throw netErr;
      await sleep(backoff(attempt));
      continue;
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      if (attempt >= maxAttempts) {
        throw new NetworkError(`Telegram вернул не-JSON (HTTP ${res.status}): ${raw.slice(0, 200)}`);
      }
      await sleep(backoff(attempt));
      continue;
    }

    if (body.ok) return body.result as T;

    const err = new TelegramError(
      body.error_code ?? res.status,
      body.description ?? 'неизвестная ошибка',
      body.parameters?.retry_after,
    );

    if (err.permanent || attempt >= maxAttempts) {
      log.warn('Telegram API вернул ошибку', {
        method,
        code: err.code,
        description: err.description,
      });
      throw err;
    }

    const delay = err.retryAfter ? err.retryAfter * 1000 + 300 : backoff(attempt);
    log.warn('Повтор запроса к Telegram', { method, code: err.code, delay, attempt });
    await sleep(delay);
  }
}

function backoff(attempt: number): number {
  return Math.min(2 ** attempt * 500, 15_000) + Math.floor(Math.random() * 300);
}

/* ------------------------------ обёртки методов ----------------------------- */

export const tg = {
  getMe: () => call<TgUser>('getMe'),

  getChat: (chat_id: number) => call<TgChat>('getChat', { chat_id }),

  getChatMember: (chat_id: number, user_id: number) =>
    call<any>('getChatMember', { chat_id, user_id }),

  sendMessage: (p: {
    chat_id: number;
    text: string;
    message_thread_id?: number;
    reply_to_message_id?: number;
    disable_notification?: boolean;
    link_preview_options?: { is_disabled?: boolean };
  }) => call<TgMessage>('sendMessage', p, { throttleChat: p.chat_id }),

  /**
   * Копия сообщения без пометки «переслано».
   * Работает с любым типом контента — поэтому текст, фото, файлы, голосовые
   * и кружки обрабатываются одним вызовом, без разбора типов.
   */
  copyMessage: (p: {
    chat_id: number;
    from_chat_id: number;
    message_id: number;
    message_thread_id?: number;
  }) => call<{ message_id: number }>('copyMessage', p, { throttleChat: p.chat_id }),

  createForumTopic: (p: { chat_id: number; name: string; icon_color?: number }) =>
    call<{ message_thread_id: number; name: string }>('createForumTopic', p),

  editForumTopic: (p: { chat_id: number; message_thread_id: number; name: string }) =>
    call<boolean>('editForumTopic', p),

  closeForumTopic: (p: { chat_id: number; message_thread_id: number }) =>
    call<boolean>('closeForumTopic', p),

  reopenForumTopic: (p: { chat_id: number; message_thread_id: number }) =>
    call<boolean>('reopenForumTopic', p),

  setMessageReaction: (p: {
    chat_id: number;
    message_id: number;
    reaction: { type: 'emoji'; emoji: string }[];
  }) => call<boolean>('setMessageReaction', p, { attempts: 1 }),

  getUpdates: (p: { offset?: number; timeout?: number; allowed_updates?: string[] }) =>
    call<TgUpdate[]>('getUpdates', p, {
      timeoutMs: (p.timeout ?? 25) * 1000 + 10_000,
      attempts: 1,
    }),

  setWebhook: (p: {
    url: string;
    secret_token?: string;
    allowed_updates?: string[];
    drop_pending_updates?: boolean;
  }) => call<boolean>('setWebhook', p),

  deleteWebhook: (drop_pending_updates = false) =>
    call<boolean>('deleteWebhook', { drop_pending_updates }),

  getWebhookInfo: () => call<any>('getWebhookInfo'),
};

/** Нам нужны только обычные сообщения. */
export const ALLOWED_UPDATES = ['message'];
