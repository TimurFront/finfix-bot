import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface SentMessage {
  chat_id: number;
  message_thread_id?: number;
  text: string;
}

export interface CopiedMessage {
  chat_id: number;
  from_chat_id: number;
  message_id: number;
  message_thread_id?: number;
}

export interface Topic {
  id: number;
  name: string;
  closed: boolean;
  deleted: boolean;
}

/**
 * Заглушка Bot API для тестов: обычный http-сервер на случайном порту,
 * приложение направляется на него через TELEGRAM_API_BASE.
 * Позволяет смоделировать блокировку бота, удаление топика и лимит 429.
 */
export class MockTelegram {
  private server: http.Server;
  private nextThreadId = 100;
  private nextMessageId = 5000;

  readonly sent: SentMessage[] = [];
  readonly copies: CopiedMessage[] = [];
  readonly topics = new Map<number, Topic>();
  readonly reactions: { chat_id: number; message_id: number; emoji: string }[] = [];
  readonly calls: string[] = [];

  /** Пользователи, которые «заблокировали бота». */
  readonly blocked = new Set<number>();
  /** Сколько ближайших вызовов должны вернуть 429. */
  private rateLimitFor = 0;

  botId = 777;
  botUsername = 'test_relay_bot';
  groupId = -1001234567890;
  groupTitle = 'Клиенты';
  groupIsForum = true;
  botIsAdmin = true;
  botCanManageTopics = true;

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const method = (req.url ?? '').split('/').pop() ?? '';
        let p: any = {};
        try {
          p = body ? JSON.parse(body) : {};
        } catch {
          /* пусто */
        }
        this.calls.push(method);

        const reply = (obj: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        const fail = (code: number, description: string, extra: object = {}) =>
          reply({ ok: false, error_code: code, description, ...extra });

        if (this.rateLimitFor > 0 && method !== 'getUpdates') {
          this.rateLimitFor--;
          return fail(429, 'Too Many Requests: retry later', { parameters: { retry_after: 1 } });
        }

        switch (method) {
          case 'getMe':
            return reply({
              ok: true,
              result: {
                id: this.botId,
                is_bot: true,
                first_name: 'Relay',
                username: this.botUsername,
              },
            });

          case 'getChat':
            if (Number(p.chat_id) !== this.groupId) return fail(400, 'Bad Request: chat not found');
            return reply({
              ok: true,
              result: {
                id: this.groupId,
                type: 'supergroup',
                title: this.groupTitle,
                is_forum: this.groupIsForum,
              },
            });

          case 'getChatMember':
            return reply({
              ok: true,
              result: {
                status: this.botIsAdmin ? 'administrator' : 'member',
                can_manage_topics: this.botCanManageTopics,
                user: { id: this.botId, is_bot: true, first_name: 'Relay' },
              },
            });

          case 'createForumTopic': {
            if (!this.groupIsForum) return fail(400, 'Bad Request: the chat is not a forum');
            const id = this.nextThreadId++;
            this.topics.set(id, { id, name: String(p.name), closed: false, deleted: false });
            return reply({ ok: true, result: { message_thread_id: id, name: p.name } });
          }

          case 'closeForumTopic': {
            const t = this.topics.get(Number(p.message_thread_id));
            if (!t || t.deleted) return fail(400, 'Bad Request: message thread not found');
            t.closed = true;
            return reply({ ok: true, result: true });
          }

          case 'reopenForumTopic': {
            const t = this.topics.get(Number(p.message_thread_id));
            if (!t || t.deleted) return fail(400, 'Bad Request: message thread not found');
            t.closed = false;
            return reply({ ok: true, result: true });
          }

          case 'sendMessage': {
            const err = this.checkTarget(Number(p.chat_id), p.message_thread_id);
            if (err) return fail(err.code, err.description);
            this.sent.push({
              chat_id: Number(p.chat_id),
              message_thread_id: p.message_thread_id,
              text: String(p.text ?? ''),
            });
            return reply({
              ok: true,
              result: {
                message_id: this.nextMessageId++,
                date: Math.floor(Date.now() / 1000),
                chat: { id: Number(p.chat_id), type: 'supergroup' },
                text: p.text,
              },
            });
          }

          case 'copyMessage': {
            const err = this.checkTarget(Number(p.chat_id), p.message_thread_id);
            if (err) return fail(err.code, err.description);
            this.copies.push({
              chat_id: Number(p.chat_id),
              from_chat_id: Number(p.from_chat_id),
              message_id: Number(p.message_id),
              message_thread_id: p.message_thread_id,
            });
            return reply({ ok: true, result: { message_id: this.nextMessageId++ } });
          }

          case 'setMessageReaction':
            this.reactions.push({
              chat_id: Number(p.chat_id),
              message_id: Number(p.message_id),
              emoji: p.reaction?.[0]?.emoji ?? '',
            });
            return reply({ ok: true, result: true });

          case 'deleteWebhook':
          case 'setWebhook':
            return reply({ ok: true, result: true });

          case 'getWebhookInfo':
            return reply({ ok: true, result: { url: '', pending_update_count: 0 } });

          case 'getUpdates':
            return reply({ ok: true, result: [] });

          default:
            return fail(400, `Bad Request: unknown method ${method}`);
        }
      });
    });
  }

  private checkTarget(chatId: number, threadId: unknown): { code: number; description: string } | null {
    if (chatId !== this.groupId) {
      // личный чат с клиентом
      if (this.blocked.has(chatId)) {
        return { code: 403, description: 'Forbidden: bot was blocked by the user' };
      }
      return null;
    }
    if (threadId === undefined || threadId === null) return null; // General
    const t = this.topics.get(Number(threadId));
    if (!t || t.deleted) return { code: 400, description: 'Bad Request: message thread not found' };
    if (t.closed) return { code: 400, description: 'Bad Request: TOPIC_CLOSED' };
    return null;
  }

  /* --------------------------- управление в тестах -------------------------- */

  /** Имитирует ручное удаление топика в Telegram. */
  deleteTopic(threadId: number) {
    const t = this.topics.get(threadId);
    if (t) t.deleted = true;
  }

  /** Имитирует топик, созданный человеком вручную (не ботом). */
  addTopic(name: string): number {
    const id = this.nextThreadId++;
    this.topics.set(id, { id, name, closed: false, deleted: false });
    return id;
  }

  /** Следующие n вызовов вернут 429 с retry_after. */
  rateLimitNext(n = 1) {
    this.rateLimitFor = n;
  }

  postsIn(threadId: number): SentMessage[] {
    return this.sent.filter((m) => m.message_thread_id === threadId);
  }

  copiesTo(chatId: number): CopiedMessage[] {
    return this.copies.filter((c) => c.chat_id === chatId);
  }

  copiesInTopic(threadId: number): CopiedMessage[] {
    return this.copies.filter((c) => c.message_thread_id === threadId);
  }

  reset() {
    this.sent.length = 0;
    this.copies.length = 0;
    this.reactions.length = 0;
    this.calls.length = 0;
  }

  start(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
