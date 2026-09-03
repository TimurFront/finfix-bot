import { config } from './config';
import { log } from './log';
import {
  ClientRow,
  claimUpdate,
  countClients,
  getClientByThreadId,
  getClientByUserId,
  setBanned,
  setThreadId,
  upsertClient,
} from './store';
import { TelegramError, TgMessage, TgUpdate, tg } from './telegram';

/** id самого бота — чтобы не реагировать на собственные сообщения в группе. */
let botId = 0;
export function setBotId(id: number) {
  botId = id;
}

/** Строка, начинающаяся с этого префикса, остаётся в топике и клиенту не уходит. */
const NOTE_PREFIX = '//';

/* -------------------------------- вспомогательное -------------------------- */

export function displayName(c: {
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  user_id?: number;
}): string {
  const full = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (c.username) return '@' + c.username;
  return `ID ${c.user_id ?? '?'}`;
}

function topicName(c: ClientRow): string {
  const base = displayName(c);
  const withUser = c.username && !base.startsWith('@') ? `${base} (@${c.username})` : base;
  return withUser.slice(0, 120);
}

const TOPIC_COLORS = [0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f];

function topicColor(userId: number): number {
  return TOPIC_COLORS[Math.abs(userId) % TOPIC_COLORS.length];
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function infoCard(c: ClientRow): string {
  const lines = [
    `👤 ${displayName(c)}`,
    [c.username ? '@' + c.username : null, `ID ${c.user_id}`, c.phone].filter(Boolean).join(' · '),
  ];
  if (c.language_code) lines.push(`Язык: ${c.language_code}`);
  lines.push(`Первое обращение: ${dateFmt.format(new Date(c.first_seen_at))}`);
  if (c.banned) lines.push('🚫 Клиент в игноре (/unban — снять)');
  lines.push('');
  lines.push('Пишите прямо в этот топик — сообщение уйдёт клиенту.');
  lines.push(`Строка, начинающаяся с ${NOTE_PREFIX}, останется здесь. /help — команды.`);
  return lines.join('\n');
}

/** Отправка служебного текста в топик; при неудаче — в общий чат группы. */
async function notifyTopic(threadId: number | null, text: string) {
  try {
    await tg.sendMessage({
      chat_id: config.groupId,
      message_thread_id: threadId ?? undefined,
      text,
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (threadId !== null) {
      try {
        await tg.sendMessage({ chat_id: config.groupId, text });
        return;
      } catch {
        /* группа недоступна — остаётся только лог */
      }
    }
    log.error('Не удалось написать в группу', { err: String(err) });
  }
}

/* ------------------------------ создание топика ---------------------------- */

/** Возвращает id топика клиента, создавая его при необходимости. */
async function ensureTopic(client: ClientRow, forceNew = false): Promise<number> {
  if (client.thread_id !== null && !forceNew) return client.thread_id;

  const topic = await tg.createForumTopic({
    chat_id: config.groupId,
    name: topicName(client),
    icon_color: topicColor(client.user_id),
  });

  setThreadId(client.user_id, topic.message_thread_id);
  log.info('Создан топик', {
    user: client.user_id,
    thread: topic.message_thread_id,
    name: topic.name,
  });

  const fresh = getClientByUserId(client.user_id)!;
  await notifyTopic(topic.message_thread_id, infoCard(fresh));

  return topic.message_thread_id;
}

/* --------------------------- клиент → группа ------------------------------- */

async function handleClientMessage(msg: TgMessage) {
  const from = msg.from!;
  const now = Date.now();

  const existing = getClientByUserId(from.id);

  const client = upsertClient(
    {
      userId: from.id,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
      languageCode: from.language_code ?? null,
      // номер приходит, только если клиент сам поделился контактом
      phone: msg.contact?.user_id === from.id ? msg.contact.phone_number : null,
    },
    now,
  );

  if (client.banned) {
    log.info('Сообщение от клиента в игноре — пропускаем', { user: from.id });
    return;
  }

  // /start отдельным сообщением полезно показать оператору, но клиенту
  // бот отвечает только если это явно включено через WELCOME_TEXT
  const isStart = (msg.text ?? '').trim() === '/start';

  let threadId = await ensureTopic(client);

  const deliver = async (thread: number) =>
    tg.copyMessage({
      chat_id: config.groupId,
      message_thread_id: thread,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });

  try {
    await deliver(threadId);
  } catch (err) {
    if (err instanceof TelegramError && err.topicGone) {
      // топик удалили руками — создаём заново и повторяем один раз
      log.warn('Топик удалён, создаём заново', { user: from.id });
      threadId = await ensureTopic(client, true);
      await deliver(threadId);
    } else if (err instanceof TelegramError && err.description.toLowerCase().includes('closed')) {
      // топик закрыт — открываем и повторяем
      await tg.reopenForumTopic({ chat_id: config.groupId, message_thread_id: threadId });
      await deliver(threadId);
    } else if (err instanceof TelegramError && err.permanent) {
      // например, контент, который Telegram запрещает копировать
      const fallback = msg.text ?? msg.caption ?? '';
      await notifyTopic(
        threadId,
        `⚠ Сообщение клиента не удалось перенести (${err.human}).` +
          (fallback ? `\n\nТекст: ${fallback}` : ''),
      );
      log.error('Не удалось скопировать сообщение клиента', {
        user: from.id,
        err: err.description,
      });
    } else {
      throw err;
    }
  }

  if (!existing) {
    log.info('Новый клиент', { user: from.id, name: displayName(client) });
  }

  if (isStart && config.welcomeText) {
    await tg.sendMessage({ chat_id: from.id, text: config.welcomeText });
    await notifyTopic(threadId, '↩️ Клиенту отправлено приветствие (WELCOME_TEXT).');
  }
}

/* --------------------------- группа → клиент ------------------------------- */

async function handleGroupMessage(msg: TgMessage) {
  const from = msg.from;
  if (!from) return;

  // собственные копии сообщений клиентов и служебные посты бота
  if (from.id === botId || from.is_bot) return;

  // служебные события форума
  if (
    msg.forum_topic_created ||
    msg.forum_topic_edited ||
    msg.forum_topic_closed ||
    msg.forum_topic_reopened ||
    msg.new_chat_members ||
    msg.left_chat_member ||
    msg.pinned_message
  ) {
    return;
  }

  const text = (msg.text ?? '').trim();
  const threadId = msg.message_thread_id ?? null;

  if (text.startsWith('/')) {
    const handled = await handleCommand(text, msg, threadId);
    if (handled) return;
  }

  // General-топик к клиенту не привязан
  if (threadId === null) return;

  // внутренняя заметка — остаётся в топике
  if (text.startsWith(NOTE_PREFIX)) return;

  const client = getClientByThreadId(threadId);
  if (!client) {
    await notifyTopic(
      threadId,
      'Этот топик не привязан к клиенту, отправлять некому.\n' +
        'Топики создаются автоматически, когда клиент пишет боту.',
    );
    return;
  }

  if (client.banned) {
    await notifyTopic(threadId, '🚫 Клиент в игноре. Снимите через /unban, чтобы отвечать.');
    return;
  }

  try {
    await tg.copyMessage({
      chat_id: client.user_id,
      from_chat_id: config.groupId,
      message_id: msg.message_id,
    });

    log.info('Ответ доставлен клиенту', { user: client.user_id, operator: from.id });

    if (config.confirmWithReaction) {
      // подтверждение доставки — галочка на сообщении оператора
      await tg
        .setMessageReaction({
          chat_id: config.groupId,
          message_id: msg.message_id,
          reaction: [{ type: 'emoji', emoji: '👌' }],
        })
        .catch(() => undefined);
    }
  } catch (err) {
    const reason = err instanceof TelegramError ? err.human : String(err);
    await notifyTopic(threadId, `⚠ Не доставлено: ${reason}`);
    log.error('Не удалось доставить ответ клиенту', { user: client.user_id, err: reason });
  }
}

/* --------------------------------- команды --------------------------------- */

const HELP = [
  'Команды (пишутся в топике клиента):',
  '',
  '/info — карточка клиента',
  '/id — Telegram ID клиента',
  '/close — закрыть топик; новое сообщение клиента откроет его снова',
  '/ban — перестать принимать и отправлять сообщения этому клиенту',
  '/unban — снять игнор',
  '/stats — сколько всего клиентов',
  '/help — эта справка',
  '',
  `Обычный текст в топике уходит клиенту. Строка, начинающаяся с ${NOTE_PREFIX}, — нет.`,
].join('\n');

async function handleCommand(
  text: string,
  msg: TgMessage,
  threadId: number | null,
): Promise<boolean> {
  // обрезаем @botname у команд вида /info@my_bot
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const client = threadId !== null ? getClientByThreadId(threadId) : undefined;

  const needClient = async (): Promise<ClientRow | null> => {
    if (client) return client;
    await notifyTopic(threadId, 'Эта команда работает только в топике клиента.');
    return null;
  };

  switch (cmd) {
    case '/help':
    case '/start':
      await notifyTopic(threadId, HELP);
      return true;

    case '/id':
      if (client) await notifyTopic(threadId, `Telegram ID клиента: ${client.user_id}`);
      else await notifyTopic(threadId, `ID этой группы: ${msg.chat.id}`);
      return true;

    case '/info': {
      const c = await needClient();
      if (c) await notifyTopic(threadId, infoCard(c));
      return true;
    }

    case '/stats':
      await notifyTopic(threadId, `Клиентов в базе: ${countClients()}`);
      return true;

    case '/close': {
      const c = await needClient();
      if (!c) return true;
      await notifyTopic(threadId, '✅ Топик закрыт. Новое сообщение клиента откроет его снова.');
      await tg
        .closeForumTopic({ chat_id: config.groupId, message_thread_id: threadId! })
        .catch((err) => log.warn('Не удалось закрыть топик', { err: String(err) }));
      return true;
    }

    case '/ban': {
      const c = await needClient();
      if (!c) return true;
      setBanned(c.user_id, true);
      await notifyTopic(threadId, `🚫 ${displayName(c)} в игноре. Сообщения не принимаются.`);
      return true;
    }

    case '/unban': {
      const c = await needClient();
      if (!c) return true;
      setBanned(c.user_id, false);
      await notifyTopic(threadId, `✅ Игнор снят с ${displayName(c)}.`);
      return true;
    }

    default:
      return false; // не наша команда — пусть уйдёт клиенту как обычный текст
  }
}

/* ------------------------------ точка входа -------------------------------- */

/**
 * Обработка одного апдейта. Не бросает исключений наружу:
 * вебхук обязан ответить 200 в любом случае, иначе Telegram зациклит повторы.
 */
export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (!claimUpdate(update.update_id)) {
    log.debug('Повторная доставка апдейта, пропускаем', { update_id: update.update_id });
    return;
  }

  const msg = update.message;
  if (!msg || !msg.from) return;

  try {
    if (msg.chat.type === 'private') {
      if (msg.from.is_bot) return;
      await handleClientMessage(msg);
      return;
    }

    if (msg.chat.id === config.groupId) {
      await handleGroupMessage(msg);
      return;
    }

    // Бот в какой-то другой группе. Чаще всего это значит, что человек только что
    // добавил его в рабочую группу и ещё не знает её id — подсказываем.
    if (msg.chat.type === 'supergroup' || msg.chat.type === 'group') {
      log.warn(
        `Сообщение из неизвестной группы «${msg.chat.title ?? ''}». ` +
          `Если это ваша рабочая группа, укажите в .env:  GROUP_ID=${msg.chat.id}`,
      );
    }
  } catch (err) {
    log.error('Ошибка обработки апдейта', {
      update_id: update.update_id,
      err: String(err instanceof Error ? err.stack ?? err.message : err),
    });
  }
}
