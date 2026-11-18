# Production: GitHub Actions → GHCR → VPS

Production использует ветку `main`, GitHub environment `production` и отдельный Compose `Docker/compose.production.yaml`. GitHub Actions проверяет код, публикует образ в GHCR и передаёт на VPS его неизменяемый digest (`ghcr.io/<owner>/<repository>@sha256:<digest>`). VPS запускает готовый образ; исходники соседних репозиториев и сборка на сервере не нужны.

Общая подготовка сервера и связей трёх приложений описана в [production-инструкции backend](https://github.com/fedornabilkin/klan-backend/blob/main/Docs/deployment-github-vps.md). Workflow этого репозитория — [Production](../.github/workflows/deploy.yml).

Локальная разработка через Node.js остаётся описана в [основной инструкции](deployment.md). Production-файл не является override для локального Compose: его запускают отдельно с project name `klan-bot-production`.

## Подготовка VPS

Нужны Linux x86_64, Bash, Docker Engine, Docker Compose **2.30.0+**, SSH, `flock`, `curl` и доступ к GHCR и Telegram по HTTPS. Compose 2.30.0 нужен для [`env_file.format: raw`](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/): символы `$` и кавычки внутри значений не преобразуются.

Пользователь deploy должен иметь доступ к Docker и право записи в заранее созданный каталог `/opt/klan/bot/releases`. Доступ к Docker даёт широкие права на сервере; используйте отдельный SSH-ключ для этого deployment. Постоянные GHCR credentials на VPS не нужны: workflow передаёт временный `GITHUB_TOKEN` через SSH stdin, сервер использует отдельный временный `DOCKER_CONFIG` и удаляет его по окончании. Пакет GHCR должен разрешать чтение этому репозиторию через его `GITHUB_TOKEN`.

Создайте общие ресурсы один раз:

```sh
docker network inspect klan-production >/dev/null 2>&1 || docker network create klan-production
docker volume inspect klan-production-bot-state >/dev/null 2>&1 || docker volume create klan-production-bot-state
```

Сеть общая для трёх приложений; production API подключается к ней с DNS alias `api` и портом 3001. Volume принадлежит боту и хранится независимо от релизов. Контейнер работает как UID/GID `1000:1000`; каталог volume должен быть доступен ему для записи. Production Compose не публикует порты бота.

Для нового пустого volume применяется обычное [копирование каталога из образа при первом монтировании](https://docs.docker.com/engine/storage/volumes/#mounting-a-volume-over-existing-data): `Docker/Dockerfile` заранее создаёт `/var/lib/klan-bot` с владельцем `node:node`. Наличие `external: true` означает, что volume создаётся отдельно; `volume-nocopy` здесь не используется. Если volume уже заполнен или перенесён вручную, его владельца проверяют отдельно; исправление описано ниже.

Первое развёртывание выполняйте в порядке **backend → frontend → bot**. До запуска бота API должен возвращать `200` и `data.status=ok`, `data.demo=false` на `http://api:3001/api/health`. Публичный reverse proxy не должен открывать `/internal/`.

## GitHub environment и secrets

В настройках репозитория создайте environment `production` и разрешите deployment только из `main`. Для автоматического production после проверок выключите **Required reviewers** и **Wait timer**. Secrets этого environment:

| Secret | Значение |
| --- | --- |
| `DEPLOY_HOST` | SSH hostname или IP VPS |
| `DEPLOY_PORT` | SSH-порт, обычно `22` |
| `DEPLOY_USER` | Пользователь deploy на VPS |
| `DEPLOY_SSH_KEY` | Приватный SSH-ключ этого deployment |
| `DEPLOY_KNOWN_HOSTS` | Проверенная запись ключа SSH-сервера; для нестандартного порта — `[host]:port` |
| `PRODUCTION_ENV` | Многострочное runtime-окружение по примеру ниже |

Проверьте fingerprint SSH-сервера через доверенный канал перед сохранением `DEPLOY_KNOWN_HOSTS`. Не отключайте проверку ключа сервера.

Скопируйте содержимое [Docker/.env.production.example](../Docker/.env.production.example) в secret `PRODUCTION_ENV` и заполните два значения:

```dotenv
TELEGRAM_BOT_TOKEN=
BOT_BACKEND_SECRET=
```

Формат — отдельные строки `KEY=value`, без `export`, внешних кавычек или ссылок `${OTHER_VARIABLE}`. Значения передаются буквально. Не добавляйте реальные настройки в Git. `TELEGRAM_BOT_TOKEN` должен совпадать с токеном API. `BOT_BACKEND_SECRET` должен в точности совпадать с `BOT_INTERNAL_SECRET` у API: 32–256 ASCII-символов без пробелов; используйте случайно сгенерированный секрет.

Production Compose фиксирует `NODE_ENV=production`, `BOT_BACKEND_URL=http://api:3001`, `BOT_STATE_FILE=/var/lib/klan-bot/offset.json`. Эти параметры не нужно включать в `PRODUCTION_ENV`. Образ задаётся deployment через `IMAGE_REF` с digest, а не через runtime-файл.

## Первый запуск и сохранённый offset

Один Telegram-токен должен обслуживать **ровно один polling worker**. До первого production deployment остановите прежний worker: локальный Node.js-процесс, старый Compose или systemd-службу. Проверьте все места, где этот токен мог использоваться. Deployment останавливает предыдущий worker своего production Compose project; он не может найти экземпляры на других компьютерах или в других проектах.

Для polling у этого токена должен быть отключён webhook. Уточните его существующее состояние отдельно; preflight не обращается к Telegram, а deployment не изменяет webhook автоматически. Не включайте удаление ожидающих обновлений при переходе. После запуска сам worker начинает обычный polling.

Если бот уже работал, после его остановки сделайте резервную копию `offset.json` и перенесите её в volume `klan-production-bot-state` под тем же именем. Не запускайте новый worker, пока перенос не завершён. Например, на VPS с абсолютным путём к скопированному файлу:

```sh
docker run --rm --network none --user 0 --entrypoint sh \
  --mount type=bind,source=/absolute/path/offset.json,target=/migration/offset.json,readonly \
  --mount type=volume,source=klan-production-bot-state,target=/var/lib/klan-bot \
  node:24-bookworm-slim -eu -c 'test ! -e /var/lib/klan-bot/offset.json; test ! -L /var/lib/klan-bot/offset.json; install -d -o 1000 -g 1000 -m 750 /var/lib/klan-bot; install -o 1000 -g 1000 -m 600 /migration/offset.json /var/lib/klan-bot/offset.json'
```

Команда не перезаписывает существующий production offset. Замените абсолютный путь к резервной копии. Для операции используется публичный базовый образ без приложения; контейнер запускает только копирование и не подключается к сети. Для нового токена без предыдущего worker допустим пустой volume: бот начинает с offset `0` и получает доступные ожидающие обновления.

Не удаляйте volume при обновлении или rollback. Повреждённый offset останавливает запуск и требует проверки сохранённого файла, а не автоматического сброса.

### Если preflight сообщает об ошибке доступа к volume

Сначала остановите worker и сохраните резервную копию состояния. Если проблема именно во владельце или правах, следующий вспомогательный контейнер исправляет только права каталога и двух файлов состояния, сохраняя их содержимое. Он не запускает бота и не имеет сетевого доступа:

```sh
docker run --rm -i --network none --user 0 --entrypoint sh \
  --mount type=volume,source=klan-production-bot-state,target=/var/lib/klan-bot \
  node:24-bookworm-slim -eu <<'SH'
chown 1000:1000 /var/lib/klan-bot
chmod 750 /var/lib/klan-bot
for file in /var/lib/klan-bot/offset.json /var/lib/klan-bot/offset.json.tmp; do
  if [ -e "$file" ] || [ -L "$file" ]; then
    test -f "$file"
    test ! -L "$file"
    chown 1000:1000 "$file"
    chmod 600 "$file"
  fi
done
SH
```

После этого повторите workflow `Production`. Не удаляйте offset ради успешного preflight; неверный JSON и ошибки API исправляются отдельно от файловых прав.

## Выпуск и проверка

Push в `main` автоматически запускает workflow **Production**: проверки → сборка и публикация образа → обновление VPS. Для повторного выпуска текущей `main` откройте **Actions → Production → Run workflow** и выберите `main`. Pull request запускает только проверки. Устаревший запуск не развёртывается, если `main` уже перешла на другой коммит.

Каждый релиз размещается в `/opt/klan/bot/releases/<SHA>-<run>-<attempt>` и содержит `Docker/compose.production.yaml`, `Deploy/*.sh` и приватный `runtime.env`. Ссылки `current` и `previous` указывают на релизы для текущей версии и rollback. Release script блокирует параллельные обновления одного сервиса, загружает образ по digest и выполняет hooks из этого релиза.

До остановки текущего worker выполняются проверки:

1. Наличие внешней сети и volume.
2. Офлайн-проверка формата токена, секрета и адресов через `--check-config`.
3. Возможность доступа к каталогу состояния и чтения существующего offset без его изменения; доступ к оставшемуся временному файлу, если он существует.
4. `GET /api/health` по внутреннему адресу API с timeout и запретом redirect. Telegram, `/internal/telegram/updates` и отправка сообщений в этой проверке не используются.

После успешного preflight старый production worker останавливается. Только затем Compose создаёт один новый контейнер из нужного образа. При ошибке запуска общий release script возвращает предыдущий релиз через его собственные hooks; постоянный offset остаётся тем же.

Проверка после запуска наблюдает процесс 30 секунд: должен существовать ровно один контейнер, который работает и не перезапускается. **Это проверка стабильности процесса, а не подтверждение доставки Telegram.** Worker продолжает работать и повторять запросы при ошибочном токене, недоступном Telegram или несовпадении общего секрета. Формат токена не подтверждает его действительность; health API не проверяет общий секрет. После выпуска проверьте эксплуатационные журналы и, когда это разрешено, обычный пользовательский сценарий входа.

Проверки и логи не должны выводить токен, `Authorization`, URL Telegram с токеном или тела сообщений. Не публикуйте содержимое `runtime.env` и не запускайте `docker compose config` без `--quiet`, поскольку развёрнутая конфигурация содержит секреты.

## Ручной rollback

На VPS от имени пользователя deploy:

```sh
bash /opt/klan/bot/current/Deploy/server-release.sh rollback
```

Команда переключает приложение на `previous`, используя сохранённый локальный образ и hooks предыдущего релиза. Registry credentials и доступ к registry для rollback не нужны. Должны сохраняться каталог предыдущего релиза, его `runtime.env` и image по digest; не удаляйте их очисткой Docker или releases. При этом preflight снова проверяет API по внутренней сети, а запущенный worker использует Telegram как обычно.

Offset остаётся в том же volume и не откатывается. Текущий worker останавливается перед запуском предыдущей версии. При неудаче rollback release script пытается восстановить тот релиз, который работал до этой команды.

## Проверки изменений deployment

Из `Project/`:

```sh
npm test
npm run typecheck
npm run build
```

Из корня репозитория, в Bash:

```sh
bash -n Deploy/service.sh
bash Scripts/test-deployment.sh
```

Тест hooks использует подставные Docker/Compose-команды: проверяет запрет запуска нового worker при неудачной остановке старого, передачу ошибок orchestration и отклонение рестартов/нескольких контейнеров. Реальные Docker, Telegram, сообщения и production offset он не использует. Сборку образа и синтаксис production Compose дополнительно проверяет CI.
