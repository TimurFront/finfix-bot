# Деплой на Oracle Cloud Free Tier

Пошаговая инструкция: с нуля до работающего 24/7 бота на бесплатной виртуалке.

Часть A (аккаунт и сервер) вы делаете в браузере сами — я туда попасть не могу.
Часть B и C — команды, которые вы вводите в SSH-сессии на сервере; они даны построчно, копируйте как есть.

---

## Важно знать заранее

**Oracle попросит банковскую карту при регистрации** — для верификации личности. Списаний не будет, пока вы не превысите лимиты Always Free (а бот в них не упрётся никогда). Если это стоп-фактор — скажите, подберём вариант без карты (например, свой ПК).

---

## Часть A — аккаунт и виртуальный сервер (браузер)

### A1. Регистрация

1. https://www.oracle.com/cloud/free/ → **Start for free**.
2. Заполните форму (страна, имя, email), подтвердите email и телефон по SMS.
3. Введите данные карты (только верификация, тариф — Always Free).
4. Дождитесь письма «Your account is ready» и войдите в консоль: https://cloud.oracle.com

### A2. Создание виртуальной машины

1. Слева вверху ☰ → **Compute** → **Instances** → **Create instance**.
2. **Name**: `telegram-bot`.
3. **Image and shape** → **Edit**:
   - Image: **Canonical Ubuntu** (последняя версия, напр. 24.04) — оставьте по умолчанию.
   - Shape: нажмите **Change shape** → вкладка **Ampere** → `VM.Standard.A1.Flex`, выставьте **1 OCPU / 6 GB RAM**. Важно: должна стоять пометка **«Always Free eligible»**.
   - Если Oracle пишет "Out of capacity" (ARM-мощности иногда заканчиваются в регионе) — переключитесь на вкладку **Specialty and previous generation** → `VM.Standard.E2.1.Micro`, тоже Always Free, но послабее (1 vCPU / 1 GB). Для этого бота хватит с запасом.
4. **Networking**: оставьте всё по умолчанию — убедитесь, что галка **«Assign a public IPv4 address»** включена.
5. **Add SSH keys**: выберите **Generate a key pair for me** → нажмите **Save private key**. Файл `ssh-key-....key` сохранится в Загрузки — **это единственный шанс его скачать**, потеряете — потеряете доступ.
6. **Create**. Через 1–2 минуты статус сменится на **Running** — на странице инстанса скопируйте **Public IP Address**.

Дальше — на своём ПК, в PowerShell.

---

## Часть B — первое подключение и установка Node.js

### B1. Подключение по SSH

Перенесите скачанный `.key`-файл, например, в `C:\oracle-key\ssh-key.key`, и в PowerShell:

```powershell
icacls.exe "C:\oracle-key\ssh-key.key" /reset
icacls.exe "C:\oracle-key\ssh-key.key" /grant:r "$($env:USERNAME):(R)"
icacls.exe "C:\oracle-key\ssh-key.key" /inheritance:r
```

Это обязательно — без узких прав на файл Windows-ssh откажется его использовать. Дальше подключаемся (замените `ВАШ_IP` на скопированный Public IP):

```powershell
ssh -i "C:\oracle-key\ssh-key.key" ubuntu@ВАШ_IP
```

На первый вопрос про fingerprint ответьте `yes`. Вы внутри сервера — дальше все команды выполняются уже там.

### B2. Установка Node.js 22 и git

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v
```

Должно показать `v22.x.x`.

---

## Часть C — код бота и запуск

### C1. Публикация кода на GitHub (со своего ПК, не на сервере)

Код уже подготовлен и закоммичен локально. Осталось создать пустой репозиторий и запушить.

1. Откройте https://github.com/new
2. **Repository name**: например `telegram-relay-bot`. Public или Private — на ваш выбор, секретов в коде нет (токен хранится только в `.env`, он в `.gitignore` и никогда не коммитится).
3. **НЕ** ставьте галки «Add README» / «.gitignore» / «license» — они уже есть локально, лишний файл вызовет конфликт при первом пуше.
4. **Create repository**.

GitHub покажет команды для «existing repository» — выполните их в PowerShell **в папке проекта**:

```powershell
git remote add origin https://github.com/ВАШ_ЛОГИН/telegram-relay-bot.git
git branch -M main
git push -u origin main
```

Если Git попросит войти — откроется окно браузера, войдите своим GitHub-аккаунтом.

### C2. Скачивание кода на сервер

Снова в SSH-сессии на сервере:

```bash
git clone https://github.com/ВАШ_ЛОГИН/telegram-relay-bot.git
cd telegram-relay-bot
npm ci
npm run build
```

### C3. Настройка .env

```bash
cp .env.example .env
nano .env
```

Впишите:
```
TELEGRAM_BOT_TOKEN=ваш_токен_от_BotFather
MODE=polling
```
`GROUP_ID` пока оставьте пустым — узнаем его на следующем шаге. Сохранить в nano: `Ctrl+O`, `Enter`, выйти — `Ctrl+X`.

> **Почему `MODE=polling`, а не `webhook`:** polling не требует открытых портов и настройки firewall — у Oracle их два уровня (облачный Security List и системный iptables), и вебхук почти всегда сначала спотыкается именно об это. Polling просто сам стучится к Telegram — ничего дополнительно открывать не нужно.

### C4. Узнать GROUP_ID и проверить, что всё работает

```bash
npm start
```

Добавьте бота в вашу Telegram-группу (см. README.md — там есть про Group Privacy и темы). Напишите что-нибудь в группе — в консоли появится строка вида:

```
Если это ваша рабочая группа, укажите в .env:  GROUP_ID=-1001234567890
```

Нажмите `Ctrl+C`, впишите этот `GROUP_ID` в `.env` (`nano .env`), сохраните.

### C5. Запуск как постоянной службы (автозапуск + автоперезапуск)

```bash
sudo cp deploy/telegram-relay-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-relay-bot
sudo systemctl status telegram-relay-bot
```

Статус должен быть `active (running)`. Готово — бот работает 24/7, переживёт перезагрузку сервера и сам поднимется после сбоя.

Смотреть логи в реальном времени:
```bash
journalctl -u telegram-relay-bot -f
```
(выход — `Ctrl+C`, сама служба продолжит работать).

---

## Обновление бота в будущем

Если я пришлю изменения в код — на сервере:

```bash
cd ~/telegram-relay-bot
git pull
npm ci
npm run build
sudo systemctl restart telegram-relay-bot
```

---

## Если что-то не так

| Проблема | Что проверить |
|---|---|
| `systemctl status` показывает `failed` | `journalctl -u telegram-relay-bot -n 50` — там будет причина |
| Бот не отвечает в группе | Group Privacy у бота (см. README.md) — самая частая причина |
| `ssh` не подключается | Публичный IP не сменился? (после Stop/Start инстанса он может смениться, если не зарезервирован) |
| Не хватает памяти на E2.1.Micro | `free -h` — если совсем впритык, добавьте своп: `sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
