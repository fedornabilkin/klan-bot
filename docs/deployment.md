# Развёртывание Klan Bot

Достаточно клонировать этот репозиторий. Приложение поддерживает запуск через Node.js и контейнер. Оно не обращается к исходникам соседних сервисов, базе данных или внешним файлам сборки. Для работы нужны доступ к Telegram по HTTPS и HTTP(S)-адрес уже настроенного Klan API.

## Конфигурация

| Переменная | Назначение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Токен того же бота, который указан у Klan API |
| `BOT_BACKEND_SECRET` | Общий секрет, равный `BOT_INTERNAL_SECRET` у API; 32–256 непустых ASCII-символов без пробелов |
| `BOT_BACKEND_URL` | Origin API для Node.js: схема и хост, без пути и завершающего слеша |
| `BOT_STATE_FILE` | Путь к постоянному файлу offset с правом записи; относительный путь считается от рабочей директории |
| `CONTAINER_BACKEND_URL` | Origin API для Compose; подставляется контейнеру как `BOT_BACKEND_URL` |
| `KLAN_NETWORK` | Имя внешней Docker-сети для необязательного `deploy/compose.network.yaml`, по умолчанию `klan` |

Скопируйте `.env.example` в `.env` или передайте окружение средствами хостинга. Реальные секреты не входят в Docker image и Git. `npm run check:config` проверяет формат без сетевых запросов; после сборки то же делает `npm run check:config:built` без devDependencies. Эта проверка не подтверждает действительность токена или доступность API.

Боту нужен прямой доступ к `/internal/telegram/updates`. Публичный reverse proxy не должен публиковать `/internal/`; выбирайте частный адрес API. Через недоверенную сеть используйте HTTPS. Адрес страницы frontend вместо API не подходит. Один токен обслуживает один экземпляр worker; у токена не должно быть активного Telegram webhook.

## Docker Compose

Все команды выполняются из этого репозитория. Заполните `.env`, затем:

```sh
docker compose build
docker compose run --rm bot node dist/main.js --check-config
docker compose up -d
docker compose logs -f bot
```

Контейнер работает от пользователя `node`. Именованный volume `bot-state` монтируется в `/var/lib/klan-bot`; Docker при создании нового volume переносит владельца каталога из image. Если используете bind mount вместо volume, заранее выдайте каталогу права записи UID/GID 1000:1000.

По умолчанию Compose обращается к API на `http://host.docker.internal:3001`. Маппинг `host-gateway` добавлен для Linux. API должен слушать интерфейс, достижимый из контейнера: `127.0.0.1` хоста на Linux недостаточно. Не публикуйте внутренний API в интернет ради этой связи: используйте частный интерфейс, правила firewall или общую Docker-сеть. Для отдельного сервера задайте `CONTAINER_BACKEND_URL` равным его частному HTTP(S) origin.

### Общая Docker-сеть с API

Для API в отдельном Compose-проекте на том же Docker-хосте приложен необязательный `deploy/compose.network.yaml`. Создайте сеть один раз и подключите к ней API с DNS alias `api`. В репозитории backend есть собственный файл подключения к той же сети. Ни один Compose-файл бота не читает файлы backend.

```sh
docker network create klan
docker compose -f compose.yaml -f deploy/compose.network.yaml build
docker compose -f compose.yaml -f deploy/compose.network.yaml run --rm bot node dist/main.js --check-config
docker compose -f compose.yaml -f deploy/compose.network.yaml up -d
```

Если сеть уже существует, повторно создавать её не нужно. Для другого имени задайте одинаковый `KLAN_NETWORK` у бота и API и создайте сеть с этим именем. Этот override выбирает `BOT_BACKEND_URL=http://api:3001`, независимо от `CONTAINER_BACKEND_URL`. Для обновления, журналов и остановки используйте те же два аргумента `-f`. Так worker обращается к API по внутренней сети, даже если HTTP-порт backend на хосте опубликован только на `127.0.0.1`.

### Обновление и перенос

Для обновления обычного Compose выполните `docker compose up -d --build`. Остановка: `docker compose down`. Сохраняйте volume и не добавляйте `--volumes`, иначе потеряется подтверждённая позиция Telegram. Перед переносом offset на другой сервер остановите старый worker, перенесите файл или volume и только затем запускайте новый экземпляр.

Для другой контейнерной платформы соберите `docker build -t klan-bot .`, передайте четыре runtime-переменные (`TELEGRAM_BOT_TOKEN`, `BOT_BACKEND_SECRET`, `BOT_BACKEND_URL`, `BOT_STATE_FILE`) и подключите постоянный volume с правом записи. Значение `BOT_STATE_FILE` в image уже равно `/var/lib/klan-bot/offset.json`. Приложение не слушает HTTP-порт.

## Node.js и Linux systemd

Нужны Node.js 22.12+ и npm. В целевом каталоге приложения:

```sh
npm ci
npm run build
npm prune --omit=dev
```

Пример [deploy/klan-bot.service](../deploy/klan-bot.service) предполагает каталог `/opt/klan-bot`, бинарник `/usr/bin/node`, системного пользователя `klan-bot` и окружение `/etc/klan-bot.env`. Измените пути под окружение. Пользователь должен иметь права чтения приложения, но не обязан иметь права записи в него. Unit создаёт `/var/lib/klan-bot` с нужным владельцем через `StateDirectory`.

Создайте системного пользователя и файл окружения; это пример для новой Linux-установки:

```sh
sudo useradd --system --user-group --home-dir /var/lib/klan-bot --shell /usr/sbin/nologin klan-bot
sudo install -o root -g klan-bot -m 0640 .env.example /etc/klan-bot.env
sudoedit /etc/klan-bot.env
```

В `/etc/klan-bot.env` задайте настоящие токен, секрет и адрес API, `NODE_ENV=production` и `BOT_STATE_FILE=/var/lib/klan-bot/offset.json`. Строки `CONTAINER_BACKEND_URL` и `KLAN_NETWORK` при Node.js-запуске не используются. Не храните дополнительный `.env` внутри `/opt/klan-bot`. Установите unit:

```sh
sudo install -m 0644 deploy/klan-bot.service /etc/systemd/system/klan-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now klan-bot
sudo journalctl -u klan-bot -f
```

Перед каждым запуском unit выполняет проверку конфигурации без сети. При обновлении остановите службу, обновите код и зависимости, выполните сборку и снова запустите службу. Offset и файл окружения при этом сохраняются вне каталога релиза. В другом менеджере процессов передайте то же окружение и запускайте `node dist/main.js` из корня приложения с обработкой SIGTERM.
