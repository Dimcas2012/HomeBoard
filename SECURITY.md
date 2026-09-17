# Security Policy

## Reporting a vulnerability

Please open a **private** GitHub security advisory or email the maintainer — do not file a public issue with exploit details for a live deployment.

## Before you deploy

- Set a unique `SECRET_KEY` in `.env`
- Use `DEBUG=False` in production
- Never commit `.env`, TLS private keys, or database passwords
- Prefer Let's Encrypt (or similar) behind a reverse proxy; do not reuse sample LAN certificates
- Restrict Django admin and pairing codes to trusted users

## Known sensitive paths (keep out of git)

- `.env`
- `certs/*.pem` (except documentation)
- Redis `dump.rdb`
- Built APKs under `android/dist/`
