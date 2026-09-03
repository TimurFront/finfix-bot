import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config';
import { log } from './log';
import { handleUpdate } from './relay';
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

/**
 * HTTP-сервер для режима webhook.
 *
 * Защита двумя слоями: секретный сегмент в пути и заголовок
 * X-Telegram-Bot-Api-Secret-Token.
 *
 * Ответ всегда 200, даже при внутренней ошибке: иначе Telegram будет
 * бесконечно повторять этот апдейт и заблокирует очередь остальных.
 */
export function startWebhookServer(): http.Server {
  const expectedPath = `/webhook/${config.webhookSecretPath}`;

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0];

    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }

    if (req.method !== 'POST' || !config.webhookSecretPath || !safeEqual(url, expectedPath)) {
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

    let update: TgUpdate | null = null;
    try {
      update = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }

    if (!update || typeof update.update_id !== 'number') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }

    try {
      await handleUpdate(update);
    } catch (err) {
      log.error('Webhook: непойманная ошибка', { err: String(err) });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  server.listen(config.port, () => {
    log.info(`Webhook-сервер слушает порт ${config.port}`);
  });

  return server;
}
