# Klan Bot

Самостоятельный Telegram worker. Получает обновления через `getUpdates` и доставляет их в Klan API по HTTP. Репозиторий содержит все файлы для собственной сборки, запуска и развёртывания. PostgreSQL и исходники других приложений боту не нужны; работающий Klan API подключается по адресу в конфигурации.

## Локальный запуск через Node.js

Нужны Node.js 22.12+ и npm. Из корня этого репозитория:

```sh
npm ci
```

Скопируйте `.env.example` в `.env`. Задайте токен BotFather, `BOT_BACKEND_URL` и `BOT_BACKEND_SECRET`. Секрет должен совпадать с `BOT_INTERNAL_SECRET` у API. `BOT_STATE_FILE=.local/offset.json` хранит подтверждённую позицию Telegram в игнорируемом каталоге; этот файл должен сохраняться между запусками.

```sh
npm run check:config
npm run dev
```

Проверка конфигурации не обращается к Telegram и не отправляет сообщения. На Windows после настройки `.env` можно запустить `start-local.cmd`: он проверит конфигурацию, соберёт приложение и запустит бота в текущем окне. Для собранного приложения на любой системе:

```sh
npm run build
npm run check:config:built
npm start
```

## Docker Compose

Нужны Docker Engine и Docker Compose v2. Используется тот же `.env`; для контейнера адрес API задаётся отдельно через `CONTAINER_BACKEND_URL`. Значение по умолчанию `http://host.docker.internal:3001` подходит, если API доступен с контейнера через интерфейс хоста. На Linux API, слушающий только `127.0.0.1`, через host-gateway недоступен; используйте частную сеть сервисов или доступный частный адрес API. Подробности — в [инструкции развёртывания](docs/deployment.md).

```sh
docker compose build
docker compose run --rm bot node dist/main.js --check-config
docker compose up -d
docker compose logs -f bot
```

Compose запускает только worker и создаёт собственный постоянный volume для offset. Для остановки используйте `docker compose down` без `--volumes`. Сборка использует только текущий репозиторий: `docker build -t klan-bot .`.

Перед запуском настройте API, разрешённые Telegram-группы и права администратора у бота. Один токен должен обслуживать только один polling worker. Webhook у этого токена должен быть отключён. Приложение само не меняет webhook и не устанавливает права в группах.

## Границы

- `src/config.ts` — проверка переменных окружения.
- `src/worker.ts` — polling, передача обновлений, повторы и завершение.
- `src/state.ts` — атомарное сохранение offset.
- `src/main.ts` — запуск и обработка сигналов.
- API проверяет членство в группах, связывает Telegram ID с профилем, подтверждает одноразовую ссылку и отвечает пользователю через `sendMessage`.

Бот не выдаёт cookie и не назначает роли. Ссылка авторизации остаётся привязанной к браузеру на стороне API. Username не заменяет числовой Telegram ID.

## Проверки и документы

`npm test`, `npm run typecheck` и `npm run build` работают без реального Telegram и без базы. Тесты используют подменённый HTTP transport и временный offset-файл. Если среда запрещает атомарное переименование файлов в системном temp, создайте `.local/test-tmp` и задайте `KLAN_TEST_TMPDIR` перед тестами. Например, в PowerShell:

```powershell
New-Item -ItemType Directory -Force .local/test-tmp | Out-Null
$env:KLAN_TEST_TMPDIR = (Resolve-Path .local/test-tmp).Path
npm.cmd test
```

В Git хранятся `Dockerfile`, `compose.yaml`, `start-local.cmd`, пример systemd unit и инструкции. Реальные `.env`, offset, журналы и результаты проверок игнорируются.

[Развёртывание и обновление](docs/deployment.md). [Протокол API и повторная доставка](docs/protocol.md). [Правила разработки](AGENTS.md).
