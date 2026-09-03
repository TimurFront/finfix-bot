/* eslint-disable no-console */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockTelegram } from './mock-telegram';

/* ----------------------------- мини тест-раннер ----------------------------- */

const results: { name: string; ok: boolean; err?: string }[] = [];
let currentGroup = '';

function group(name: string) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name: `${currentGroup} :: ${name}`, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    results.push({ name: `${currentGroup} :: ${name}`, ok: false, err: msg });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log('    \x1b[31m' + msg.split('\n').slice(0, 6).join('\n    ') + '\x1b[0m');
  }
}

/* --------------------------------- прогон ---------------------------------- */

const GROUP_ID = -1001234567890;
const OPERATOR_ID = 900001;

let updateSeq = 1000;
let messageSeq = 1;

function clientUpdate(
  user: { id: number; first_name: string; last_name?: string; username?: string },
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    update_id: updateSeq++,
    message: {
      message_id: messageSeq++,
      from: { ...user, is_bot: false, language_code: 'ru' },
      chat: { id: user.id, type: 'private' as const, first_name: user.first_name },
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    },
  };
}

function operatorUpdate(threadId: number | null, text: string, fromId = OPERATOR_ID) {
  return {
    update_id: updateSeq++,
    message: {
      message_id: messageSeq++,
      from: { id: fromId, is_bot: false, first_name: 'Оператор' },
      chat: { id: GROUP_ID, type: 'supergroup' as const, title: 'Клиенты', is_forum: true },
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

async function main() {
  const mock = new MockTelegram();
  const apiBase = await mock.start();

  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, `test-${Date.now()}.db`);
  const port = 39000 + Math.floor(Math.random() * 2000);

  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.TELEGRAM_API_BASE = apiBase;
  process.env.GROUP_ID = String(GROUP_ID);
  process.env.DB_FILE = dbFile;
  process.env.MODE = 'webhook';
  process.env.PORT = String(port);
  process.env.WEBHOOK_SECRET_PATH = 'secret-path-abc123';
  process.env.WEBHOOK_SECRET_TOKEN = 'secret-header-xyz789';
  process.env.WELCOME_TEXT = '';
  process.env.LOG_LEVEL = 'error';

  // config читает переменные окружения при импорте — поэтому импорт динамический
  const { openStore, closeStore, getClientByUserId } = await import('../store');
  const { handleUpdate, setBotId, displayName } = await import('../relay');
  const { startWebhookServer } = await import('../webhook');

  openStore();
  setBotId(mock.botId);

  const IVAN = { id: 700001, first_name: 'Иван', last_name: 'Кузнецов', username: 'ivan_k' };
  const MARIA = { id: 700002, first_name: 'Мария', username: 'maria_s' };
  const PETR = { id: 700003, first_name: 'Пётр' };

  const threadOf = (userId: number) => getClientByUserId(userId)?.thread_id ?? null;

  /* ======================= 1. Клиент пишет впервые ======================== */

  group('1. Клиент пишет впервые');

  await test('создаётся топик с именем клиента', async () => {
    await handleUpdate(clientUpdate(IVAN, 'Здравствуйте, сколько стоит доставка?'));
    const thread = threadOf(IVAN.id);
    assert.ok(thread, 'у клиента должен появиться топик');
    const topic = mock.topics.get(thread!);
    assert.ok(topic, 'топик должен быть создан в группе');
    assert.equal(topic!.name, 'Иван Кузнецов (@ivan_k)');
  });

  await test('в топик отправлена карточка клиента', async () => {
    const thread = threadOf(IVAN.id)!;
    const card = mock.postsIn(thread)[0];
    assert.ok(card, 'первым сообщением должна быть карточка');
    assert.match(card.text, /Иван Кузнецов/);
    assert.match(card.text, /@ivan_k/);
    assert.match(card.text, new RegExp(String(IVAN.id)));
  });

  await test('сообщение клиента скопировано в топик', async () => {
    const thread = threadOf(IVAN.id)!;
    const copies = mock.copiesInTopic(thread);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].chat_id, GROUP_ID);
    assert.equal(copies[0].from_chat_id, IVAN.id);
  });

  await test('клиент сохранён с именем, фамилией и username', async () => {
    const c = getClientByUserId(IVAN.id)!;
    assert.equal(c.first_name, 'Иван');
    assert.equal(c.last_name, 'Кузнецов');
    assert.equal(c.username, 'ivan_k');
    assert.equal(c.language_code, 'ru');
    assert.equal(displayName(c), 'Иван Кузнецов');
  });

  await test('бот НИЧЕГО не написал клиенту сам', async () => {
    assert.equal(
      mock.sent.filter((m) => m.chat_id === IVAN.id).length,
      0,
      'в личку клиенту не должно уходить ни одного автоматического сообщения',
    );
  });

  /* ==================== 2. Повторные сообщения и клиенты =================== */

  group('2. Повторные сообщения и другие клиенты');

  await test('второе сообщение попадает в тот же топик', async () => {
    const before = mock.topics.size;
    await handleUpdate(clientUpdate(IVAN, 'ул. Абая 25'));
    assert.equal(mock.topics.size, before, 'новый топик создаваться не должен');
    assert.equal(mock.copiesInTopic(threadOf(IVAN.id)!).length, 2);
  });

  await test('другой клиент получает свой топик', async () => {
    await handleUpdate(clientUpdate(MARIA, 'Работаете в воскресенье?'));
    const t1 = threadOf(IVAN.id);
    const t2 = threadOf(MARIA.id);
    assert.ok(t2);
    assert.notEqual(t1, t2);
    assert.equal(mock.topics.size, 2);
  });

  await test('клиент без username именуется по имени', async () => {
    await handleUpdate(clientUpdate(PETR, 'Привет'));
    const topic = mock.topics.get(threadOf(PETR.id)!)!;
    assert.equal(topic.name, 'Пётр');
  });

  await test('изменившийся username обновляется', async () => {
    await handleUpdate(clientUpdate({ ...MARIA, username: 'maria_new' }, 'Ещё вопрос'));
    assert.equal(getClientByUserId(MARIA.id)!.username, 'maria_new');
  });

  /* ========================= 3. Ответ оператора ============================ */

  group('3. Ответ оператора');

  await test('текст из топика уходит клиенту', async () => {
    const thread = threadOf(IVAN.id)!;
    await handleUpdate(operatorUpdate(thread, 'Доставка по городу 1500 ₸.'));
    const toClient = mock.copiesTo(IVAN.id);
    assert.equal(toClient.length, 1);
    assert.equal(toClient[0].from_chat_id, GROUP_ID);
  });

  await test('ответ помечается реакцией — подтверждение доставки', async () => {
    assert.equal(mock.reactions.length, 1);
    assert.equal(mock.reactions[0].chat_id, GROUP_ID);
    assert.equal(mock.reactions[0].emoji, '👌');
  });

  await test('ответ уходит именно тому клиенту, чей это топик', async () => {
    const thread = threadOf(MARIA.id)!;
    await handleUpdate(operatorUpdate(thread, 'Да, работаем.'));
    assert.equal(mock.copiesTo(MARIA.id).length, 1);
    assert.equal(mock.copiesTo(IVAN.id).length, 1, 'Ивану ничего лишнего уйти не должно');
  });

  await test('внутренняя заметка // клиенту не уходит', async () => {
    const before = mock.copiesTo(IVAN.id).length;
    await handleUpdate(operatorUpdate(threadOf(IVAN.id)!, '// перезвонить после обеда'));
    assert.equal(mock.copiesTo(IVAN.id).length, before);
  });

  /* ====================== 4. Защита от зацикливания ======================== */

  group('4. Защита от зацикливания и лишних сообщений');

  await test('сообщения самого бота в группе игнорируются', async () => {
    const before = mock.copies.length;
    const upd = operatorUpdate(threadOf(IVAN.id)!, 'копия сообщения клиента', mock.botId);
    (upd.message.from as any).is_bot = true;
    await handleUpdate(upd);
    assert.equal(mock.copies.length, before, 'бот не должен реагировать на самого себя');
  });

  await test('сообщение в General (без топика) игнорируется', async () => {
    const before = mock.copies.length;
    await handleUpdate(operatorUpdate(null, 'просто болтаем в общем чате'));
    assert.equal(mock.copies.length, before);
  });

  await test('служебное сообщение о создании топика игнорируется', async () => {
    const before = mock.copies.length;
    const upd = operatorUpdate(threadOf(IVAN.id)!, '');
    (upd.message as any).forum_topic_created = { name: 'x' };
    await handleUpdate(upd);
    assert.equal(mock.copies.length, before);
  });

  await test('повторная доставка того же update_id не дублирует', async () => {
    const upd = clientUpdate(IVAN, 'Дубликат');
    await handleUpdate(upd);
    const after1 = mock.copiesInTopic(threadOf(IVAN.id)!).length;
    await handleUpdate(upd);
    await handleUpdate(upd);
    assert.equal(mock.copiesInTopic(threadOf(IVAN.id)!).length, after1);
  });

  await test('сообщение из чужой группы не обрабатывается', async () => {
    const before = mock.copies.length;
    await handleUpdate({
      update_id: updateSeq++,
      message: {
        message_id: messageSeq++,
        from: { id: 5, is_bot: false, first_name: 'Кто-то' },
        chat: { id: -100999, type: 'supergroup', title: 'Чужая' },
        date: Math.floor(Date.now() / 1000),
        text: 'привет',
      },
    } as any);
    assert.equal(mock.copies.length, before);
  });

  /* ========================= 5. Сбои и ошибки ============================== */

  group('5. Сбои и ошибки Telegram');

  await test('удалённый вручную топик пересоздаётся', async () => {
    const oldThread = threadOf(IVAN.id)!;
    mock.deleteTopic(oldThread);
    await handleUpdate(clientUpdate(IVAN, 'Сообщение после удаления топика'));

    const newThread = threadOf(IVAN.id)!;
    assert.notEqual(newThread, oldThread, 'должен быть создан новый топик');
    assert.equal(mock.copiesInTopic(newThread).length, 1, 'сообщение должно дойти');
    assert.ok(mock.postsIn(newThread).some((m) => /Иван Кузнецов/.test(m.text)), 'нужна новая карточка');
  });

  await test('клиент заблокировал бота — оператор видит причину в топике', async () => {
    const thread = threadOf(MARIA.id)!;
    mock.blocked.add(MARIA.id);
    await handleUpdate(operatorUpdate(thread, 'Вы ещё здесь?'));
    const last = mock.postsIn(thread).at(-1)!;
    assert.match(last.text, /Не доставлено/);
    assert.match(last.text, /заблокировал бота/);
    mock.blocked.delete(MARIA.id);
  });

  await test('ошибка 429 не теряет сообщение — повтор и доставка', async () => {
    const thread = threadOf(PETR.id)!;
    const before = mock.copiesInTopic(thread).length;
    mock.rateLimitNext(1);
    await handleUpdate(clientUpdate(PETR, 'Сообщение сквозь лимит'));
    assert.equal(mock.copiesInTopic(thread).length, before + 1);
  });

  await test('ответ в созданном вручную топике даёт понятную подсказку', async () => {
    // человек сам создал топик в группе — он ни к какому клиенту не привязан
    const orphan = mock.addTopic('Обсуждение внутри команды');
    await handleUpdate(operatorUpdate(orphan, 'Кому это уйдёт?'));
    const last = mock.postsIn(orphan).at(-1);
    assert.ok(last, 'должна прийти подсказка');
    assert.match(last!.text, /не привязан к клиенту/);
    assert.equal(mock.copies.filter((c) => c.message_id === messageSeq - 1).length, 0);
  });

  /* ============================ 6. Команды ================================= */

  group('6. Команды в топике');

  await test('/info показывает карточку клиента', async () => {
    const thread = threadOf(IVAN.id)!;
    await handleUpdate(operatorUpdate(thread, '/info'));
    const last = mock.postsIn(thread).at(-1)!;
    assert.match(last.text, /Иван Кузнецов/);
    assert.match(last.text, /@ivan_k/);
  });

  await test('/id показывает Telegram ID клиента', async () => {
    const thread = threadOf(IVAN.id)!;
    await handleUpdate(operatorUpdate(thread, '/id'));
    assert.match(mock.postsIn(thread).at(-1)!.text, new RegExp(String(IVAN.id)));
  });

  await test('/id в General показывает ID группы', async () => {
    await handleUpdate(operatorUpdate(null, '/id'));
    const generalPosts = mock.sent.filter(
      (m) => m.chat_id === GROUP_ID && m.message_thread_id === undefined,
    );
    assert.match(generalPosts.at(-1)!.text, /-1001234567890/);
  });

  await test('/help отвечает справкой, клиенту не уходит', async () => {
    const thread = threadOf(IVAN.id)!;
    const before = mock.copiesTo(IVAN.id).length;
    await handleUpdate(operatorUpdate(thread, '/help'));
    assert.match(mock.postsIn(thread).at(-1)!.text, /Команды/);
    assert.equal(mock.copiesTo(IVAN.id).length, before);
  });

  await test('/ban перестаёт принимать сообщения клиента', async () => {
    const thread = threadOf(PETR.id)!;
    await handleUpdate(operatorUpdate(thread, '/ban'));
    assert.equal(getClientByUserId(PETR.id)!.banned, 1);

    const before = mock.copiesInTopic(thread).length;
    await handleUpdate(clientUpdate(PETR, 'Ещё пишу'));
    assert.equal(mock.copiesInTopic(thread).length, before, 'сообщение не должно пересылаться');
  });

  await test('/ban блокирует и ответы оператора', async () => {
    const thread = threadOf(PETR.id)!;
    const before = mock.copiesTo(PETR.id).length;
    await handleUpdate(operatorUpdate(thread, 'Ответ забаненному'));
    assert.equal(mock.copiesTo(PETR.id).length, before);
    assert.match(mock.postsIn(thread).at(-1)!.text, /в игноре/);
  });

  await test('/unban возвращает всё как было', async () => {
    const thread = threadOf(PETR.id)!;
    await handleUpdate(operatorUpdate(thread, '/unban'));
    assert.equal(getClientByUserId(PETR.id)!.banned, 0);

    const before = mock.copiesInTopic(thread).length;
    await handleUpdate(clientUpdate(PETR, 'Снова пишу'));
    assert.equal(mock.copiesInTopic(thread).length, before + 1);
  });

  await test('/close закрывает топик, новое сообщение открывает его снова', async () => {
    const thread = threadOf(IVAN.id)!;
    await handleUpdate(operatorUpdate(thread, '/close'));
    assert.equal(mock.topics.get(thread)!.closed, true);

    const before = mock.copiesInTopic(thread).length;
    await handleUpdate(clientUpdate(IVAN, 'Новый вопрос после закрытия'));
    assert.equal(mock.topics.get(thread)!.closed, false, 'топик должен переоткрыться');
    assert.equal(mock.copiesInTopic(thread).length, before + 1);
  });

  await test('неизвестная команда уходит клиенту как обычный текст', async () => {
    const thread = threadOf(IVAN.id)!;
    const before = mock.copiesTo(IVAN.id).length;
    await handleUpdate(operatorUpdate(thread, '/promo скидка 10%'));
    assert.equal(mock.copiesTo(IVAN.id).length, before + 1);
  });

  /* ====================== 7. Медиа и контакты ============================== */

  group('7. Медиа и контакты');

  await test('фото проходит тем же путём, без разбора типов', async () => {
    const user = { id: 700010, first_name: 'Фотограф' };
    await handleUpdate(
      clientUpdate(user, '', {
        text: undefined,
        photo: [{ file_id: 'small' }, { file_id: 'big' }],
        caption: 'Вот чек',
      }),
    );
    const thread = threadOf(user.id)!;
    assert.equal(mock.copiesInTopic(thread).length, 1, 'фото копируется как есть');
  });

  await test('оператор может отправить клиенту файл тем же способом', async () => {
    const user = { id: 700011, first_name: 'Клиент' };
    await handleUpdate(clientUpdate(user, 'Пришлите прайс'));
    const thread = threadOf(user.id)!;
    const upd = operatorUpdate(thread, '');
    (upd.message as any).text = undefined;
    (upd.message as any).document = { file_id: 'price.pdf' };
    await handleUpdate(upd);
    assert.equal(mock.copiesTo(user.id).length, 1);
  });

  await test('контакт клиента сохраняет номер телефона', async () => {
    const user = { id: 700012, first_name: 'Контакт' };
    await handleUpdate(
      clientUpdate(user, '', {
        text: undefined,
        contact: { phone_number: '+77010000000', user_id: 700012 },
      }),
    );
    assert.equal(getClientByUserId(user.id)!.phone, '+77010000000');
  });

  /* ===================== 8. /start и отсутствие автоответов ================= */

  group('8. /start и отсутствие автоответов');

  await test('/start от клиента виден оператору, но ответа клиенту нет', async () => {
    const user = { id: 700020, first_name: 'Новичок' };
    await handleUpdate(clientUpdate(user, '/start'));
    const thread = threadOf(user.id)!;
    assert.equal(mock.copiesInTopic(thread).length, 1, 'оператор должен увидеть обращение');
    assert.equal(
      mock.sent.filter((m) => m.chat_id === user.id).length,
      0,
      'при пустом WELCOME_TEXT клиенту не уходит ничего',
    );
  });

  /* =============================== 9. Webhook ============================== */

  group('9. Webhook');

  const server = startWebhookServer();
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${port}`;

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  await test('health отвечает', async () => {
    const res = await fetch(base + '/health');
    assert.equal(res.status, 200);
  });

  await test('неверный путь — 404', async () => {
    const res = await post('/webhook/wrong-path', clientUpdate(IVAN, 'взлом'));
    assert.equal(res.status, 404);
  });

  await test('неверный secret-token в заголовке — 403', async () => {
    const res = await post('/webhook/secret-path-abc123', clientUpdate(IVAN, 'взлом'), {
      'x-telegram-bot-api-secret-token': 'forged',
    });
    assert.equal(res.status, 403);
  });

  await test('корректный запрос принимается и сообщение доходит', async () => {
    const thread = threadOf(IVAN.id)!;
    const before = mock.copiesInTopic(thread).length;
    const res = await post('/webhook/secret-path-abc123', clientUpdate(IVAN, 'Через вебхук'), {
      'x-telegram-bot-api-secret-token': 'secret-header-xyz789',
    });
    assert.equal(res.status, 200);
    assert.equal(mock.copiesInTopic(thread).length, before + 1);
  });

  await test('мусор в теле не роняет сервер — всегда 200', async () => {
    const res = await fetch(base + '/webhook/secret-path-abc123', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'secret-header-xyz789',
      },
      body: 'не json',
    });
    assert.equal(res.status, 200);
  });

  /* ============================ 10. Нагрузка =============================== */

  group('10. Несколько клиентов одновременно');

  await test('10 клиентов пишут параллельно — 10 отдельных топиков', async () => {
    const users = Array.from({ length: 10 }, (_, i) => ({
      id: 710000 + i,
      first_name: `Клиент${i}`,
    }));
    await Promise.all(users.map((u, i) => handleUpdate(clientUpdate(u, `Вопрос ${i}`))));

    const threads = new Set(users.map((u) => threadOf(u.id)));
    assert.equal(threads.size, 10, `должно быть 10 разных топиков, получилось ${threads.size}`);
    for (const u of users) {
      assert.equal(mock.copiesInTopic(threadOf(u.id)!).length, 1, `потеряно сообщение от ${u.id}`);
    }
  });

  /* ================================ итоги ================================== */

  server.close();
  closeStore();
  await mock.stop();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(60));
  console.log(
    `Всего проверок: ${results.length}   успешно: ${results.length - failed.length}   провалено: ${failed.length}`,
  );
  console.log('─'.repeat(60));
  if (failed.length) {
    console.log('\nПровалившиеся проверки:');
    for (const f of failed) console.log(`  ✗ ${f.name}\n    ${f.err}`);
  }

  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbFile + suffix, { force: true });
    } catch {
      /* файл занят — не критично */
    }
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Тесты не смогли запуститься:', err);
  process.exit(1);
});
