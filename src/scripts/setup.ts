/* eslint-disable no-console */
import { config } from '../config';
import { tg } from '../telegram';

/**
 * Диагностика настройки. Проверяет всё, что обычно забывают:
 * токен, группу, темы, права бота, режим приватности.
 */

const ok = (s: string) => console.log('  \x1b[32m✓\x1b[0m ' + s);
const bad = (s: string) => console.log('  \x1b[31m✗\x1b[0m ' + s);
const warn = (s: string) => console.log('  \x1b[33m!\x1b[0m ' + s);

(async () => {
  console.log('\nПроверка настройки\n' + '─'.repeat(50));

  if (!config.botToken) {
    bad('TELEGRAM_BOT_TOKEN не задан в .env');
    console.log('\n    Получите токен у @BotFather: /newbot\n');
    process.exit(1);
  }

  let me;
  try {
    me = await tg.getMe();
    ok(`Токен рабочий. Бот: @${me.username} (id ${me.id})`);
  } catch (err: any) {
    bad('Токен не принят Telegram: ' + String(err?.message ?? err));
    process.exit(1);
  }

  if (!config.groupId) {
    bad('GROUP_ID не задан в .env');
    console.log(`
    Что сделать:
      1. Создайте приватную группу в Telegram.
      2. Управление группой → включите «Темы» (Topics).
         Если переключателя нет — сначала сделайте группу супергруппой,
         добавив в неё любого второго участника.
      3. Добавьте @${me.username} в группу и назначьте администратором
         с правом «Управление темами».
      4. Запустите бота (npm run dev) и напишите что-нибудь в группе —
         в логе появится строка вида  GROUP_ID=-1001234567890
      5. Впишите этот id в .env и перезапустите.
`);
    process.exit(1);
  }

  let chat;
  try {
    chat = await tg.getChat(config.groupId);
    ok(`Группа найдена: «${chat.title}» (${chat.type})`);
  } catch (err: any) {
    bad('Группа не читается: ' + String(err?.message ?? err));
    console.log('\n    Проверьте GROUP_ID и что бот добавлен в группу.\n');
    process.exit(1);
  }

  if (chat.type !== 'supergroup') {
    bad(`Это ${chat.type}, а нужна супергруппа с темами.`);
    console.log('    Добавьте в группу второго участника — Telegram сам сделает её супергруппой.');
  }

  if (chat.is_forum) ok('Темы (Topics) включены');
  else bad('Темы выключены. Управление группой → Темы. Без них бот работать не будет.');

  try {
    const member = await tg.getChatMember(config.groupId, me.id);
    const status = member?.status;
    if (status === 'administrator') {
      ok('Бот — администратор группы');
      if (member.can_manage_topics) ok('Право «Управление темами» есть');
      else bad('Нет права «Управление темами» — бот не сможет создавать топики');
    } else {
      bad(`Бот в группе как «${status}», нужен администратор с правом управления темами`);
    }
  } catch (err: any) {
    warn('Не удалось проверить права бота: ' + String(err?.message ?? err));
  }

  try {
    const info = await tg.getWebhookInfo();
    if (config.mode === 'webhook') {
      if (info.url) ok(`Webhook установлен: ${info.url}`);
      else warn('Режим webhook, но вебхук не зарегистрирован — выполните npm run set-webhook');
      if (info.last_error_message) warn('Последняя ошибка вебхука: ' + info.last_error_message);
    } else {
      if (info.url) warn('Режим polling, но вебхук установлен — бот снимет его при старте');
      else ok('Режим polling, вебхук не мешает');
    }
  } catch {
    warn('Не удалось получить состояние вебхука');
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`
ВАЖНО, это проверить через API нельзя:

  Режим приватности бота должен быть ВЫКЛЮЧЕН, иначе бот не увидит
  ваши ответы в группе и ничего не отправит клиенту.

    @BotFather → /mybots → @${me.username} → Bot Settings
      → Group Privacy → Turn off

  После смены настройки удалите бота из группы и добавьте заново —
  иначе она не применится.
`);
})().catch((err) => {
  console.error('Проверка прервана:', String(err?.message ?? err));
  process.exit(1);
});
