import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config';
import { log } from './log';
import { handleUpdate } from './relay';
import { parseLead, recordLead } from './leads';
import { TgUpdate } from './telegram';

/** Сравнение секретов за постоянное время. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('тело запроса слишком велико'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** Заголовки CORS для формы на сайте, если она шлёт запрос прямо из браузера. */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': config.leadsCorsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Единственный HTTP-сервер приложения. Работает всегда, независимо от того,
 * получает бот апдейты Telegram через polling или через webhook — приёму
 * заявок с сайта публичный вход нужен в любом случае.
 *
 * Маршруты:
 *   GET  /health                 — проверка живости
 *   POST /webhook/<secret>       — апдейты Telegram (используется только при MODE=webhook)
 *   POST /leads/<LEADS_SECRET>   — заявки с сайта (см. leads.ts), если секрет задан
 */
export function startHttpServer(): http.Server {
  const webhookPath = config.webhookSecretPath ? `/webhook/${config.webhookSecretPath}` : null;
  const leadsPath = config.leadsSecret ? `/leads/${config.leadsSecret}` : null;

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      return json(res, 200, { ok: true, ts: Date.now() });
    }

    /* --------------------------- заявки с сайта --------------------------- */

    if (url.startsWith('/leads/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (!leadsPath || !safeEqual(url, leadsPath)) {
        // намеренно не различаем "нет такого пути" и "неверный секрет" —
        // чтобы не подсказывать, включена ли эта функция вообще
        return json(res, 404, { ok: false, error: 'not found' }, corsHeaders());
      }

      if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: 'method not allowed' }, corsHeaders());
      }

      let raw: unknown;
      try {
        raw = JSON.parse(await readBody(req, 50_000));
      } catch (err) {
        return json(
          res,
          400,
          { ok: false, error: err instanceof Error && err.message.includes('велико') ? err.message : 'некорректный JSON' },
          corsHeaders(),
        );
      }

      const parsed = parseLead(raw);
      if (!parsed.ok) {
        return json(res, 400, { ok: false, error: parsed.error }, corsHeaders());
      }

      try {
        await recordLead(parsed.value);
        return json(res, 200, { ok: true }, corsHeaders());
      } catch (err) {
        log.error('Не удалось записать заявку с сайта', { err: String(err) });
        return json(res, 502, { ok: false, error: 'не удалось доставить заявку в Telegram' }, corsHeaders());
      }
    }

    /* ------------------------------ webhook Telegram ------------------------------ */

    if (req.method !== 'POST' || !webhookPath || !safeEqual(url, webhookPath)) {
      res.writeHead(404).end();
      return;
    }

    if (config.webhookSecretToken) {
      const got = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
      if (!safeEqual(got, config.webhookSecretToken)) {
        log.warn('Webhook: неверный secret-token в заголовке');
        res.writeHead(403).end();
        return;
      }
    }

    // Ответ Telegram всегда 200, даже при внутренней ошибке — иначе он будет
    // бесконечно повторять апдейт и заблокирует очередь остальных.
    let update: TgUpdate | null = null;
    try {
      update = JSON.parse(await readBody(req));
    } catch {
      return json(res, 200, { ok: true, ignored: true });
    }

    if (!update || typeof update.update_id !== 'number') {
      return json(res, 200, { ok: true, ignored: true });
    }

    try {
      await handleUpdate(update);
    } catch (err) {
      log.error('Webhook: непойманная ошибка', { err: String(err) });
    }

    return json(res, 200, { ok: true });
  });

  server.listen(config.port, () => {
    log.info(`HTTP-сервер слушает порт ${config.port}`, {
      webhook: webhookPath ? 'включён' : 'выключен',
      leads: leadsPath ? 'включён' : 'выключен (LEADS_SECRET не задан)',
    });
  });

  return server;
}
