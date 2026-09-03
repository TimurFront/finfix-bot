import { config } from './config';
import { log } from './log';
import { getState, setState } from './store';
import { TelegramError, tg } from './telegram';

/* --------------------------------- модель -----------------------------------
 * Форма зеркалит DemoRequest + LeadKind из FINFIXlanding (lib/validation.ts):
 *   full  — имя, компания, телефон обязательны; comment/plan/module опциональны
 *   quick — только телефон (карточка «Консультация»)
 * Сайт уже валидирует и очищает поля на своей стороне (lib/sanitize.ts) —
 * здесь защита второго слоя: не доверяем чужому клиенту вслепую, но не
 * дублируем всю логику нормализации.
 *
 * Раньше в полной заявке обязательным был telegram: форма демо спрашивала
 * username. Сайт перешёл на номер телефона с выбором кода страны, поэтому
 * теперь в обоих видах заявки канал связи один и тот же — phone.
 * ------------------------------------------------------------------------- */

export type LeadKind = 'full' | 'quick';

export interface LeadInput {
  kind: LeadKind;
  name: string;
  company: string;
  comment: string;
  phone: string; // канал связи в обоих видах заявки
  plan: string;
  module: string;
}

const LIMITS = { name: 200, company: 200, comment: 3000, phone: 32, plan: 120, module: 120 };

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

  if (!phone) {
    return {
      ok: false,
      error:
        kind === 'quick' ? 'Поле "phone" обязательно для заявки kind=quick' : 'Поле "phone" обязательно',
    };
  }
  if (!PHONE_RE.test(phone)) return { ok: false, error: 'Поле "phone" должно быть в формате +77001234567' };

  if (kind === 'quick') {
    return { ok: true, value: { kind, name: '', company: '', comment, phone, plan, module: module_ } };
  }

  const name = str(body.name, LIMITS.name);
  const company = str(body.company, LIMITS.company);

  if (!name) return { ok: false, error: 'Поле "name" обязательно' };
  if (!company) return { ok: false, error: 'Поле "company" обязательно' };

  return { ok: true, value: { kind, name, company, comment, phone, plan, module: module_ } };
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

  const lines = ['🆕 Новая заявка с сайта', '', `Имя: ${lead.name}`, `Компания: ${lead.company}`, `Телефон: ${lead.phone}`];
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

  log.info('Заявка с сайта записана', { kind: lead.kind, phone: lead.phone });
}
