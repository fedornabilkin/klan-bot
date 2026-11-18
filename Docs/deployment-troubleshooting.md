# Дополнительные операции production-бота

Обычная установка и выпуск описаны в [короткой инструкции](deployment-github-vps.md). Эти операции нужны при переносе существующего worker или разборе ошибки; репозитории frontend/backend для них не требуются.

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

## Конфигурация и адрес API

Основной файл — `/opt/klan/bot/shared/runtime.env`. После изменения запустите workflow снова: каждый выпуск сохраняет приватную копию своих настроек, а уже работающий контейнер продолжает использовать прежние значения. Если в GitHub оставлен непустой secret `PRODUCTION_ENV`, он целиком заменяет серверный файл для новых релизов; удалите этот override, чтобы вернуться к настройкам VPS. Значения не объединяются.

Формат — raw `KEY=value`, по одному значению на строку, без `export`, внешних кавычек, shell-подстановок и комментария после значения. `$`, кавычки и `#` внутри значения сохраняются буквально. Пример: [Docker/.env.production.example](../Docker/.env.production.example). Отсутствующий `BOT_BACKEND_URL` получает `http://api:3001` в копии релиза; заданный адрес не заменяется.

Для API на другом сервере укажите доступный из контейнера частный origin, например `https://api.internal.example.org`. У него должны быть доступны `GET /api/health` и `POST /internal/telegram/updates`. Публичный nginx сайта закрывает `/internal`, поэтому адрес frontend для бота не подходит. Используйте защищённую частную сеть либо проверенный HTTPS-маршрут к служебному API. Приложение запрещает redirects.

## Что проверяется при выпуске

Preflight проверяет формат конфигурации без Telegram, доступ к volume и существующему offset без изменения, затем вызывает `/api/health` указанного API. Требуются `data.status=ok` и `data.demo=false`. Старый worker останавливается только после успешной подготовки, затем запускается один новый контейнер.

После запуска процесс наблюдается 30 секунд без рестартов. Это не подтверждает доставку Telegram: неправильный токен, общий секрет или недоступность Telegram могут приводить к retry без остановки процесса. Health API не проверяет общий секрет. Проверьте журналы и разрешённый обычный сценарий входа отдельно.

## Журналы и rollback

От пользователя deploy на VPS:

```sh
cd /opt/klan/bot/current
export IMAGE_REF="$(cat image-ref)"
docker compose --project-name klan-bot-production --project-directory "$PWD/Docker" \
  --env-file /dev/null -f Docker/compose.production.yaml logs --tail 100 bot
bash /opt/klan/bot/current/Deploy/server-release.sh rollback
```

Rollback использует предыдущий локальный image, сохранённые настройки и offset volume. Shared-файл при откате не перечитывается. Нужен доступ к API для preflight; доступ к registry не требуется. При ошибке после остановки worker сценарий пытается восстановить предыдущий релиз и явно сообщает, если восстановление не удалось. Первый неудачный выпуск сохраняет данные и останавливает worker.

Релизы хранятся в `/opt/klan/bot/releases/<SHA>-<run>-<attempt>`; ссылки `current` и `previous` переключаются после успеха. Не удаляйте предыдущий каталог или image, если нужен rollback. Offset не откатывается вместе с приложением. Не выводите `runtime.env` или `docker compose config` без `--quiet`: они содержат секреты.

## Проверки разработки

Из `Project/`: `npm test`, `npm run typecheck`, `npm run build`. Из корня: `node --test Deploy/*.test.mjs` и `bash Scripts/test-deployment.sh`. Deployment-тесты используют изолированные файлы и подставные SSH/Docker; реальные Telegram и VPS не нужны.
