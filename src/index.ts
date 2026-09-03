import http from 'node:http';
import { config } from './config';
import { log } from './log';
import { closeStore, openStore, purgeOldUpdates } from './store';
import { setBotId } from './relay';
import { startPolling, stopPolling } from './poller';
import { startWebhookServer } from './webhook';
import { tg } from './telegram';

function checkConfig(): string[] {
  const problems: string[] = [];
  if (!config.botToken) problems.push('TELEGRAM_BOT_TOKEN не задан');
  if (!config.groupId) {
    problems.push(
      'GROUP_ID не задан. Добавьте бота в вашу приватную группу и напишите там что-нибудь — ' +
        'в логе появится нужный id.',
    );
  }
  if (config.mode === 'webhook') {
    if (!config.publicUrl) problems.push('PUBLIC_URL не задан (нужен для режима webhook)');
    if (!config.webhookSecretPath) problems.push('WEBHOOK_SECRET_PATH не задан');
  }
  return problems;
}

async function main() {
  openStore();

  const problems = checkConfig();
  const fatal = problems.filter((p) => p.startsWith('TELEGRAM_BOT_TOKEN'));
  for (const p of problems) log.warn('Проверьте настройки: ' + p);
  if (fatal.length) process.exit(1);

  const me = await tg.getMe();
  setBotId(me.id);
  log.info(`Бот @${me.username} запущен`, { id: me.id, mode: config.mode });

  if (config.groupId) {
    try {
      const chat = await tg.getChat(config.groupId);
      if (!chat.is_forum) {
        log.error(
          `Группа «${chat.title}» без тем. Включите: Управление группой → Темы. ` +
            'Без тем бот не сможет разделять клиентов.',
        );
      } else {
        log.info(`Рабочая группа: ${chat.title}`);
      }
    } catch (err) {
      log.error('Не удалось прочитать группу — проверьте GROUP_ID и что бот в неё добавлен', {
        err: String(err),
      });
    }
  }

  let server: http.Server | null = null;

  if (config.mode === 'webhook') {
    server = startWebhookServer();
    log.info('Не забудьте один раз выполнить: npm run set-webhook');
  } else {
    void startPolling();
  }

  // журнал апдейтов не должен расти бесконечно
  const janitor = setInterval(() => purgeOldUpdates(), 6 * 3600_000);
  janitor.unref?.();

  const shutdown = (signal: string) => {
    log.info(`Получен ${signal}, завершаем работу`);
    stopPolling();
    clearInterval(janitor);
    server?.close();
    closeStore();
    setTimeout(() => process.exit(0), 300).unref?.();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('Необработанный rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  log.error('Не удалось запустить бота', { err: String(err?.stack ?? err) });
  process.exit(1);
});
