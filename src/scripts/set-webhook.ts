/* eslint-disable no-console */
import { config } from '../config';
import { ALLOWED_UPDATES, tg } from '../telegram';

/**
 * Регистрация вебхука. Нужна только при MODE=webhook.
 * Требуются: TELEGRAM_BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET_PATH.
 */
(async () => {
  const missing: string[] = [];
  if (!config.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.publicUrl) missing.push('PUBLIC_URL');
  if (!config.webhookSecretPath) missing.push('WEBHOOK_SECRET_PATH');
  if (missing.length) {
    console.error('Не заданы переменные окружения: ' + missing.join(', '));
    process.exit(1);
  }

  if (!config.publicUrl.startsWith('https://')) {
    console.error('PUBLIC_URL должен начинаться с https:// — http Telegram не принимает');
    process.exit(1);
  }

  const url = `${config.publicUrl}/webhook/${config.webhookSecretPath}`;

  const me = await tg.getMe();
  console.log(`Бот: @${me.username}`);

  await tg.setWebhook({
    url,
    secret_token: config.webhookSecretToken || undefined,
    allowed_updates: ALLOWED_UPDATES,
  });

  const info = await tg.getWebhookInfo();
  console.log('Вебхук установлен.');
  console.log('  url:      ' + info.url);
  console.log('  ожидает:  ' + info.pending_update_count + ' апдейтов');
  if (info.last_error_message) console.log('  ошибка:   ' + info.last_error_message);
  console.log('\nУбедитесь, что на сервере MODE=webhook.');
})().catch((err) => {
  console.error('Не удалось установить вебхук:', String(err?.message ?? err));
  process.exit(1);
});
