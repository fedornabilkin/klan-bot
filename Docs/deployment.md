# Развёртывание Klan Bot

Бот запускается через Node.js без Docker. Контейнер — отдельный вариант для сервера. Для работы нужны доступ к Telegram по HTTPS и адрес настроенного Klan API. Исходники соседних репозиториев и база данных не требуются.

## Локальная работа через Node.js

Нужны Node.js 22.12+ и npm. Из корня репозитория:

```sh
node Scripts/prepare-local.mjs
cd Project
npm ci
```

Заполните `Project/.env`, затем, оставаясь в `Project/`:

```sh
npm run check:config
npm run dev
```

Для запуска без наблюдения за файлами выполните `npm run build`, затем `npm start`. На Windows `Scripts/start-local.cmd` выполняет подготовку настроек, установку отсутствующих зависимостей, проверку конфигурации, сборку и запуск в текущем окне. Docker не нужен ни для одной из этих команд.

Подготовку можно повторить из `Project/` командой `npm run setup:local`. Она не перезаписывает существующие настройки. При переходе со старой структуры сначала остановите worker, затем выполните подготовку и проверьте путь к сохранённому offset. Исходные приватные файлы сохраняются как резервные; после проверки новых путей их можно убрать вручную. Оба worker одновременно запускать нельзя.

## Конфигурация

| Переменная | Назначение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Токен того же бота, который указан у Klan API |
| `BOT_BACKEND_SECRET` | Общий секрет, равный `BOT_INTERNAL_SECRET` у API; 32–256 ASCII-символов без пробелов |
| `BOT_BACKEND_URL` | Origin API для Node.js: схема и хост, без пути и завершающего слеша |
| `BOT_STATE_FILE` | Постоянный файл offset с правом записи; относительный путь считается от `Project/` при обычном Node.js-запуске |
| `CONTAINER_BACKEND_URL` | Origin API для Docker Compose; подставляется как `BOT_BACKEND_URL` |
| `KLAN_NETWORK` | Внешняя Docker-сеть для `Docker/compose.network.yaml`, по умолчанию `klan` |

Локальные настройки находятся в `Project/.env`, контейнерные — в `Docker/.env`; оба файла исключены из Git. В systemd окружение передаётся отдельным файлом вне релиза. Переменные процесса имеют приоритет над `.env`.

`npm run check:config` проверяет формат без сетевых запросов; после сборки `npm run check:config:built` делает то же без devDependencies. Эта проверка не подтверждает действительность токена или доступность API.

Боту нужен доступ к `/internal/telegram/updates` по частному адресу API. Публичный reverse proxy не должен публиковать `/internal/`. Через недоверенную сеть используйте HTTPS. Адрес страницы frontend вместо API не подходит. Один Telegram-токен обслуживает один worker, webhook у этого токена должен быть отключён. Бот сам не меняет webhook или права в группах.

## Docker Compose

Все команды этого раздела выполняются из корня репозитория. Подготовьте окружение:

```sh
cp Docker/.env.example Docker/.env
```

Заполните токен, общий секрет и адрес API в `Docker/.env`, затем:

```sh
docker compose --env-file Docker/.env -f Docker/compose.yaml config --quiet
docker compose --env-file Docker/.env -f Docker/compose.yaml build
docker compose --env-file Docker/.env -f Docker/compose.yaml run --rm bot node dist/main.js --check-config
docker compose --env-file Docker/.env -f Docker/compose.yaml up -d
docker compose --env-file Docker/.env -f Docker/compose.yaml logs -f bot
```

Контекст сборки — только этот репозиторий. `Docker/Dockerfile.dockerignore` разрешает включать в контекст только пакет, TypeScript-конфигурацию и исходники `Project/`; приватные настройки и offset в image не попадают. Прямая сборка: `docker build -f Docker/Dockerfile -t klan-bot .`.

Контейнер работает от пользователя `node`. Именованный volume `bot-state` монтируется в `/var/lib/klan-bot`; для нового volume Docker сохраняет владельца каталога из image. Для bind mount заранее выдайте каталогу права записи UID/GID 1000:1000.

По умолчанию API находится на `http://host.docker.internal:3001`. На Linux настроен `host-gateway`, но API, слушающий только loopback хоста, через Docker bridge недоступен. Используйте частный адрес API или общую сеть контейнеров. Не публикуйте внутренний API в интернет ради этой связи.

### Общая сеть с API

Создайте сеть один раз и подключите к ней API с DNS alias `api`. В репозитории backend есть собственный Compose override для этой сети; файлы backend боту не нужны.

```sh
docker network create klan
docker compose --env-file Docker/.env -f Docker/compose.yaml -f Docker/compose.network.yaml up -d --build
```

Для другого имени задайте одинаковый `KLAN_NETWORK` у бота и API. Override использует `BOT_BACKEND_URL=http://api:3001`, независимо от `CONTAINER_BACKEND_URL`. Для всех последующих команд `logs`, `run`, `up`, `down` используйте те же `--env-file` и оба аргумента `-f`.

### Обновление и состояние

Обновление обычного Compose: `docker compose --env-file Docker/.env -f Docker/compose.yaml up -d --build`. Остановка: `docker compose --env-file Docker/.env -f Docker/compose.yaml down`.

Не добавляйте `--volumes`, если нужно сохранить подтверждённую позицию Telegram. Для переноса сначала остановите старый worker, перенесите offset или volume и только затем запускайте новый экземпляр. На другой контейнерной платформе передайте четыре runtime-переменные (`TELEGRAM_BOT_TOKEN`, `BOT_BACKEND_SECRET`, `BOT_BACKEND_URL`, `BOT_STATE_FILE`) и постоянный volume. Приложение не слушает HTTP-порт.

## Linux systemd без Docker

Разместите репозиторий в `/opt/klan-bot`. Из его корня:

```sh
cd Project
npm ci
npm run build
npm prune --omit=dev
cd ..
```

Шаблон [Deploy/klan-bot.service](../Deploy/klan-bot.service) использует рабочий каталог `/opt/klan-bot/Project`, Node `/usr/bin/node`, системного пользователя `klan-bot` и окружение `/etc/klan-bot.env`. При необходимости измените пути в unit. Unit создаёт `/var/lib/klan-bot` для offset через `StateDirectory`; каталог приложения может быть доступен только для чтения.

Пример первоначальной настройки на Linux:

```sh
sudo useradd --system --user-group --home-dir /var/lib/klan-bot --shell /usr/sbin/nologin klan-bot
sudo install -o root -g klan-bot -m 0640 Project/.env.example /etc/klan-bot.env
sudoedit /etc/klan-bot.env
```

Задайте настоящие токен, секрет и адрес API, `NODE_ENV=production`, `BOT_STATE_FILE=/var/lib/klan-bot/offset.json`. В серверном релизе не нужен дополнительный `Project/.env`. Установите службу из корня репозитория:

```sh
sudo install -m 0644 Deploy/klan-bot.service /etc/systemd/system/klan-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now klan-bot
sudo journalctl -u klan-bot -f
```

Перед каждым запуском unit проверяет конфигурацию без сети. Для обновления остановите службу, обновите исходники и зависимости, соберите приложение и снова запустите службу. Offset и окружение остаются вне каталога релиза. Другой менеджер процессов должен запускать `node dist/main.js` из `Project/` и передавать SIGTERM при остановке.
