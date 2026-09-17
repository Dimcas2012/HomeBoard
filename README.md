# HomeBoard

Self-hosted home video surveillance: phones and browsers as cameras, a PC as the monitor (**Viewer**), with motion alerts, recordings, RTSP/IP cameras, and AI analytics.

> **Українською:** домашня система відеоспостереження (телефони/браузер → камери, ПК → Viewer), motion, записи, RTSP, AI. Деталі нижче англійською.

---

## Features

- **Browser / Android cameras** — pairing code, live WebRTC grid in the Viewer
- **Remote control** — camera flip, dual (where the device allows), motion, recording, torch, eco mode
- **Talkback** — Viewer microphone → phone speakers
- **Motion detection** — sensitivity, sectors, alerts (Telegram)
- **Recordings** — clips on motion, storage limits, playback
- **IP / RTSP** — via [MediaMTX](https://github.com/bluenviron/mediamtx) into the same Viewer grid
- **AI analytics** — YOLO on the server; optional on-device prefilter in the Android WebView

## Stack

| Layer | Tech |
|--------|------|
| Backend | Django 6 + Channels (ASGI / Daphne) |
| Database | MySQL (or another engine via `DB_*`) |
| Realtime | WebSocket signaling + WebRTC |
| RTSP bridge | MediaMTX |
| Mobile | Android WebView app (`android/`) |

## Quick start (development)

### 1. Python

```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
pip install -r requirements.txt
```

For AI analytics, also install:

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install ultralytics opencv-python-headless
```

### 2. Environment

```bash
copy .env.example .env
# Edit SECRET_KEY, DB_*, ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS
```

See [`.env.example`](.env.example) for all variables.

### 3. Database & migrate

Create a MySQL database and user, then:

```bash
python manage.py migrate
python manage.py createsuperuser
```

### 4. TLS (required for `getUserMedia` on phones)

TLS certificates are **not** in this repository. Generate a self-signed cert for LAN:

```bash
mkdir certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 825 -subj "/CN=10.1.10.123"
```

Replace `CN` with the IP/hostname phones will open. More detail: [`certs/README.md`](certs/README.md).

### 5. Run

```bash
# HTTPS (recommended for phone cameras on LAN):
python manage.py runssl --addr 0.0.0.0 --port 8007

# Or Windows helper (Redis + runssl):
start_homeboard.bat
```

Open:

- Viewer: `https://<host>:8007/viewer/`
- Camera (browser): `https://<host>:8007/camera/`
- Admin: `https://<host>:8007/admin/`

On the phone, accept/trust the self-signed certificate once — otherwise the camera will not start.

### 6. Android app

See [`android/README.md`](android/README.md). Build:

```bash
cd android
./gradlew :app:assembleDebug
```

## Production notes

- Example nginx config: [`deploy/homeboard.secboard.online.conf`](deploy/homeboard.secboard.online.conf)
- Example systemd unit: [`deploy/homeboard.service`](deploy/homeboard.service) — change `User` and paths for your server
- Set `DEBUG=False`, a unique `SECRET_KEY`, and your own TURN (`TURN_URLS`, …) for WebRTC across NATs
- Use `CHANNEL_LAYER=redis` + Redis when running multiple workers
- Collect static files: `python manage.py collectstatic`

MediaMTX setup: [`mediamtx/README.md`](mediamtx/README.md)

## Security

- **Never** commit `.env`, `certs/key.pem`, or database passwords
- Before going public, ensure secrets are not in git history
- Sample LAN certificates were removed from the repo — generate your own locally

If keys were ever committed, rotate certificates and passwords on the server. See [`SECURITY.md`](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

Intended for home / lab use. You are responsible for complying with local privacy and surveillance laws.

---

## Коротко українською

- **Старт:** `.venv` → `pip install -r requirements.txt` → скопіюйте `.env.example` у `.env` → `migrate` → `runssl`
- **HTTPS обовʼязковий** для камери на телефоні; сертифікати генеруйте в `certs/` (не комітьте ключі)
- **Viewer** `/viewer/`, **камера** `/camera/`, Android-клієнт у `android/`
- **Прод:** приклади в `deploy/`; `DEBUG=False`, свій `SECRET_KEY` і TURN за потреби
