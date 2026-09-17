# HomeBoard

Домашня система відеоспостереження: телефони й браузер як камери, ПК як монітор (Viewer), з motion-алертами, записами, RTSP/IP-камерами та AI-аналітикою.

**Live demo / prod:** [homeboard.secboard.online](https://homeboard.secboard.online)

Inspired by [AlfredCamera WebViewer](https://alfred.camera/webapp/viewer/) — self-hosted, open source.

---

## Features

- **Browser / Android cameras** — pairing-код, WebRTC live у сітці Viewer
- **Remote control** — flip камери, dual (де підтримується), motion, запис, torch, eco-режим
- **Talkback** — мікрофон Viewer → динаміки телефону
- **Motion detection** — чутливість, сектори, алерти (Telegram)
- **Recordings** — кліпи при русі, ліміти сховища, playback
- **IP / RTSP** — через [MediaMTX](https://github.com/bluenviron/mediamtx) у ту ж сітку Viewer
- **AI analytics** — YOLO (сервер), опційний on-device prefilter у Android WebView

## Stack

| Layer | Tech |
|--------|------|
| Backend | Django 6 + Channels (ASGI / Daphne) |
| DB | MySQL (або інша через `DB_*`) |
| Realtime | WebSocket signaling + WebRTC |
| RTSP bridge | MediaMTX |
| Mobile | Android WebView app (`android/`) |

## Quick start (dev)

### 1. Python

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
pip install -r requirements.txt
```

Для AI-аналітики додатково:

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install ultralytics opencv-python-headless
```

### 2. Environment

```bash
copy .env.example .env
# відредагуйте SECRET_KEY, DB_*, ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS
```

### 3. Database & migrate

Створіть MySQL БД і користувача, потім:

```bash
python manage.py migrate
python manage.py createsuperuser
```

### 4. TLS (потрібно для `getUserMedia` на телефоні)

Локальні сертифікати **не** входять у репозиторій. Згенеруйте self-signed:

```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 825 -subj "/CN=10.1.10.123"
```

Або див. `certs/README.md`.

### 5. Run

```bash
# HTTPS (рекомендовано для камер у LAN):
python manage.py runssl --addr 0.0.0.0 --port 8007

# або Windows helper (Redis + runssl):
start_homeboard.bat
```

Відкрийте:

- Viewer: `https://<host>:8007/viewer/`
- Camera (браузер): `https://<host>:8007/camera/`
- Admin: `https://<host>:8007/admin/`

На телефоні підтвердіть самопідписаний сертифікат, інакше камера не відкриється.

### 6. Android app

Див. [`android/README.md`](android/README.md). Збірка:

```bash
cd android
./gradlew :app:assembleDebug
```

## Production notes

- Приклад nginx: [`deploy/homeboard.secboard.online.conf`](deploy/homeboard.secboard.online.conf)
- Приклад systemd: [`deploy/homeboard.service`](deploy/homeboard.service) — замініть `User` / шляхи під свій сервер
- `DEBUG=False`, унікальний `SECRET_KEY`, власний TURN (`TURN_URLS`…) для WebRTC через NAT
- `CHANNEL_LAYER=redis` + Redis, якщо кілька workers
- Static: `python manage.py collectstatic`

MediaMTX: [`mediamtx/README.md`](mediamtx/README.md)

## Security

- **Ніколи** не комітьте `.env`, `certs/key.pem`, паролі БД
- Перед публікацією переконайтесь, що в історії git немає секретів (див. нижче)
- Self-signed LAN-сертифікати з репо видалено; згенеруйте свої локально

Якщо колись у git потрапляли ключі — згенеруйте нові сертифікати / паролі й ротуйте їх на сервері.

## License

MIT — див. [LICENSE](LICENSE).

## Disclaimer

Проєкт для домашнього / лабораторного використання. Автор не несе відповідальності за порушення локальних законів щодо відеоспостереження — дотримуйтесь правил приватності у вашій країні.
