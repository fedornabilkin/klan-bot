# Подготовка сервера Клана

На общем VPS с Debian или Ubuntu нужен существующий пользователь `deploy` с доступом к Docker. Скопируйте на сервер [setup-server.sh](../Deploy/setup-server.sh) из любого репозитория Клана. В каталоге с файлом выполните одну команду.

```sh
sudo bash setup-server.sh
```

Скрипт создаст в `/opt/klan` отдельные каталоги фронтенда, бэкенда и бота с правами для `deploy`, а для статики — `/var/www/klan`. В Docker он подготовит сеть `klan-production` и постоянные тома для PostgreSQL и позиции чтения бота. Запуск можно повторять.

Для отдельного сервера добавьте к команде `frontend`, `backend` или `bot`. Docker нужен для бэкенда и бота. Подготовка выполняется локально на VPS. IP и порт указываются позднее, при подключении сайта. Для входа по IP понадобится HTTPS с сертификатом на этот IP.

## Подключение сайта по IP и порту

Сохраните [setup-deployment.sh](../Deploy/setup-deployment.sh) рядом с [setup-server.sh](../Deploy/setup-server.sh). На VPS выполните `sudo bash setup-deployment.sh configure-ip`. Укажите публичный IPv4, HTTPS-порт (по умолчанию `8443`) и параметры бота. Мастер настроит nginx, сохранит адрес сайта в настройках API и получит автоматически обновляемый сертификат на IP. Для проверки Let’s Encrypt нужен входящий TCP 80. Для сайта откройте выбранный HTTPS-порт. [Сертификаты на IP](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

Чтобы разрешить вход по аккаунту Telegram без проверки групп, выполните `sudo env TELEGRAM_REQUIRE_GROUP_MEMBERSHIP=false bash setup-deployment.sh configure-ip`. Мастер запросит данные бота и предложит указать числовые ID администраторов. Подтверждение входа через бота остаётся обязательным.

Для подключения GitHub выполните на своём компьютере `bash setup-deployment.sh github`. Введите тот же HTTPS-адрес с портом, например `https://203.0.113.10:8443`. Для настройки одного репозитория добавьте `frontend`, `backend` или `bot`. GitHub Actions запускает проверки и выкладку после мержа в `main`. Для первого ручного выпуска дождитесь готовности API до запуска фронтенда и бота.

## Справка для установки с доменом

Для этого сценария сохраните [setup-deployment.sh](../Deploy/setup-deployment.sh) рядом с [setup-server.sh](../Deploy/setup-server.sh).

Для отдельной настройки **бота** выполните на VPS `sudo bash setup-deployment.sh configure-domain bot`. Понадобятся x86-64, доступ к Docker Compose 2.30+, токен Telegram, действующий секрет и адрес API. Мастер сохранит параметры в `/opt/klan/bot/shared/runtime.env`. При повторном запуске можно поменять адрес API.

Токен Telegram должен совпадать с токеном у API, а `BOT_BACKEND_SECRET` — со значением `BOT_INTERNAL_SECRET` у API. Для API на том же сервере в сети `klan-production` укажите `http://api:3001`. Для API на другом VPS используйте адрес, доступный контейнеру по защищённой частной сети или HTTPS. Бот обращается к `/api/health` и `/internal/telegram/updates`. Публичный nginx сайта закрывает путь `/internal`.

Для первого выпуска остановите прежний worker с этим токеном, убедитесь, что Telegram webhook отключён, и перенесите сохранённую позицию чтения. [Перенос offset](deployment-troubleshooting.md#первый-запуск-и-сохранённый-offset)

Чтобы подключить репозиторий бота к VPS, на своём компьютере войдите через `gh auth login` и выполните `bash setup-deployment.sh github bot`. Мастер заполнит SSH-параметры в окружении `production`. Непустой старый GitHub secret `PRODUCTION_ENV` целиком заменяет настройки сервера для выпуска. После сверки значений удалите его, чтобы перейти на серверный файл.

Первый выпуск запускается через Actions → Production → Run workflow → main. Затем при мерже в `main` workflow собирает образ и передаёт его digest на VPS. Перед запуском бот проверяет окружение, позицию чтения и доступность API. Снимок настроек каждого релиза сохраняется для отката. [Workflow Production](../.github/workflows/deploy.yml) · [Журналы и возврат версии](deployment-troubleshooting.md)
