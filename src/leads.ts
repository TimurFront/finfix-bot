import { config } from './config';
import { log } from './log';
import { getState, setState } from './store';
import { TelegramError, tg } from './telegram';

/* --------------------------------- модель ----------------------------------- */

export interface LeadInput {
  name: string;
  company: string;
  telegram: string;
  about: string;
}

const LIMITS = { name: 200, company: 200, telegram: 200, about: 3000 };

/** Проверка и нормализация тела запроса от формы на сайте. */
export function parseLead(raw: unknown): { ok: true; value: LeadInput } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Тело запроса должно быть JSON-объектом' };
  }
  const body = raw as Record<string, unknown>;

  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const name = str(body.name).slice(0, LIMITS.name);
  const company = str(body.company).slice(0, LIMITS.company);
  let telegram = str(body.telegram).slice(0, LIMITS.telegram);
  const about = str(body.about).slice(0, LIMITS.about);

  if (!name) return { ok: false, error: 'Поле "name" обязательно' };
  if (!company) return { ok: false, error: 'Поле "company" обязательно' };
  if (!telegram) return { ok: false, error: 'Поле "telegram" обязательно' };

  telegram = telegram.replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(telegram)) {
    return { ok: false, error: 'Поле "telegram" должно быть username без пробелов, напр. ivan_k' };
  }

  return { ok: true, value: { name, company, telegram: '@' + telegram, about } };
}

/* -------------------------------- topic -------------------------------- */

const STATE_KEY = 'leads_topic_id';

async function getLeadsTopicId(): Promise<number | null> {
  const raw = getState(STATE_KEY);
  return raw ? Number(raw) : null;
}

async function createLeadsTopic(): Promise<number> {
  const topic = await tg.createForumTopic({
    chat_id: config.groupId,
    name: config.leadsTopicName,
    icon_color: 0x6fb9f0,
  });
  setState(STATE_KEY, String(topic.message_thread_id));
  log.info('Создан топик для заявок с сайта', { thread: topic.message_thread_id });
  return topic.message_thread_id;
}

async function ensureLeadsTopic(): Promise<number> {
  const existing = await getLeadsTopicId();
  if (existing !== null) return existing;
  return createLeadsTopic();
}

/* ------------------------------- сообщение -------------------------------- */

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatLead(lead: LeadInput): string {
  const lines = [
    '🆕 Новая заявка с сайта',
    '',
    `Имя: ${lead.name}`,
    `Компания: ${lead.company}`,
    `Telegram: ${lead.telegram}`,
  ];
  if (lead.about) lines.push('', `О бизнесе: ${lead.about}`);
  lines.push('', `Получено: ${dateFmt.format(new Date())}`);
  return lines.join('\n');
}

/* --------------------------------- запись ---------------------------------- */

/**
 * Записывает заявку в выделенный топик. Если топик удалили вручную —
 * пересоздаёт его один раз и повторяет отправку, аналогично клиентским топикам.
 */
export async function recordLead(lead: LeadInput): Promise<void> {
  let threadId = await ensureLeadsTopic();
  const text = formatLead(lead);

  try {
    await tg.sendMessage({ chat_id: config.groupId, message_thread_id: threadId, text });
  } catch (err) {
    if (err instanceof TelegramError && err.topicGone) {
      log.warn('Топик заявок удалён, создаём заново');
      threadId = await createLeadsTopic();
      await tg.sendMessage({ chat_id: config.groupId, message_thread_id: threadId, text });
    } else {
      throw err;
    }
  }

  log.info('Заявка с сайта записана', { telegram: lead.telegram, company: lead.company });
}
