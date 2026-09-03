import { config } from './config';
import { log } from './log';
import { getState, setState } from './store';
import { handleUpdate } from './relay';
import { ALLOWED_UPDATES, NetworkError, TelegramError, tg } from './telegram';

const OFFSET_KEY = 'polling_offset';

let stopping = false;

/**
 * Long-polling через getUpdates. Публичный адрес не нужен —
 * подходит и для локального запуска, и для production на небольшом потоке.
 */
export async function startPolling() {
  stopping = false;

  // getUpdates и webhook взаимоисключающи: Telegram вернёт 409, если оставить вебхук
  try {
    await tg.deleteWebhook(false);
    log.info('Webhook снят, работаем через long-polling');
  } catch (err) {
    log.warn('Не удалось снять webhook', { err: String(err) });
  }

  let offset = Number(getState(OFFSET_KEY) ?? 0) || 0;
  let backoff = 1000;

  while (!stopping) {
    try {
      const updates = await tg.getUpdates({
        offset,
        timeout: 25,
        allowed_updates: ALLOWED_UPDATES,
      });
      backoff = 1000;

      for (const u of updates) {
        await handleUpdate(u);
        offset = Math.max(offset, u.update_id + 1);
      }
      if (updates.length) setState(OFFSET_KEY, String(offset));
    } catch (err) {
      if (stopping) break;

      if (err instanceof TelegramError && err.code === 401) {
        log.error('Неверный TELEGRAM_BOT_TOKEN — polling остановлен');
        break;
      }
      if (err instanceof TelegramError && err.code === 409) {
        log.warn('Конфликт с webhook, снимаем его');
        await tg.deleteWebhook(false).catch(() => undefined);
      } else if (err instanceof TelegramError || err instanceof NetworkError) {
        log.warn('Сбой polling, повторим', { err: String(err), backoff });
      } else {
        log.error('Непредвиденный сбой polling', { err: String(err) });
      }

      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  log.info('Polling остановлен');
}

export function stopPolling() {
  stopping = true;
}
