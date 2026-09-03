import { config } from './config';
import { log } from './log';
import { getState, setState } from './store';
import { TelegramError, tg } from './telegram';

/* --------------------------------- модель -----------------------------------
 * Форма зеркалит DemoRequest + LeadKind из FINFIXlanding (lib/validation.ts):
 *   full  — имя, компания, telegram обязательны; comment/plan/module опциональны
 *   quick — только телефон (карточка «Консультация»)
 * Сайт уже валидирует и очищает поля на своей стороне (lib/sanitize.ts) —
 * здесь защита второго слоя: не доверяем чужому клиенту вслепую, но не
 * дублируем всю логику нормализации.
 * ------------------------------------------------------------------------- */

export type LeadKind = 'full' | 'quick';

export interface LeadInput {
  kind: LeadKind;
  name: string;
  company: string;
  telegram: string; // '@username' или '' для quick
  comment: string;
  phone: string; // только для quick
  plan: string;
  module: string;
}

const LIMITS = { name: 200, company: 200, telegram: 64, comment: 3000, phone: 32, plan: 120, module: 120 };

const TELEGRAM_RE = /^@[a-zA-Z0-9_]{4,32}$/;
const PHONE_RE = /^\+\d{10,15}$/;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Проверка и нормализация тела запроса. Возвращает первую найденную ошибку. */
export function parseLead(raw: unknown): { ok: true; value: LeadInput } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Тело запроса должно быть JSON-объектом' };
  }
  const body = raw as Record<string, unknown>;

  const kind: LeadKind = body.kind === 'quick' ? 'quick' : 'full';

  const phone = str(body.phone, LIMITS.phone);
  const comment = str(body.comment, LIMITS.comment);
  const plan = str(body.plan, LIMITS.plan);
  const module_ = str(body.module, LIMITS.module);

  if (kind === 'quick') {
    if (!phone) return { ok: false, error: 'Поле "phone" обязательно для заявки kind=quick' };
    if (!PHONE_RE.test(phone)) return { ok: false, error: 'Поле "phone" должно быть в формате +77001234567' };
    return { ok: true, value: { kind, name: '', company: '', telegram: '', comment, phone, plan, module: module_ } };
  }

  const name = str(body.name, LIMITS.name);
  const company = str(body.company, LIMITS.company);
  let telegram = str(body.telegram, LIMITS.telegram);

  if (!name) return { ok: false, error: 'Поле "name" обязательно' };
  if (!company) return { ok: false, error: 'Поле "company" обязательно' };
  if (!telegram) return { ok: false, error: 'Поле "telegram" обязательно' };

  if (!telegram.startsWith('@')) telegram = '@' + telegram;
  if (!TELEGRAM_RE.test(telegram)) {
    return { ok: false, error: 'Поле "telegram" должно быть в формате @username (4–32 символа)' };
  }

  return { ok: true, value: { kind, name, company, telegram, comment, phone: '', plan, module: module_ } };
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

/* ------------------------------- сообщение --------------------------------
 * Обычный текст, без HTML: поля уже очищены вызывающей стороной, но раз
 * сообщение всё равно составляем заново из отдельных полей — не даём
 * никакой разметке из чужого запроса повлиять на форматирование.
 * ------------------------------------------------------------------------- */

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatLead(lead: LeadInput): string {
  if (lead.kind === 'quick') {
    return [
      '🆕 Новая заявка на консультацию',
      '',
      `Телефон: ${lead.phone}`,
      '',
      'Источник: Landing Page — карточка «Консультация»',
      `Получено: ${dateFmt.format(new Date())}`,
    ].join('\n');
  }

  const lines = ['🆕 Новая заявка с сайта', '', `Имя: ${lead.name}`, `Компания: ${lead.company}`, `Telegram: ${lead.telegram}`];
  if (lead.comment) lines.push(`Комментарий: ${lead.comment}`);
  if (lead.plan) lines.push(`Тариф: ${lead.plan}`);
  if (lead.module) lines.push(`Доп. модуль: ${lead.module}`);
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

  log.info('Заявка с сайта записана', { kind: lead.kind, telegram: lead.telegram || undefined, phone: lead.phone || undefined });
}
