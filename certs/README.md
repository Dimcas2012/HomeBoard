# TLS certificates (local / LAN)

This folder is **gitignored**. HomeBoard needs HTTPS for phone/browser camera access (`getUserMedia`).

## Generate a self-signed cert (OpenSSL)

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 825 \
  -subj "/CN=10.1.10.123"
```

Replace `CN` with the IP or hostname phones will open (must match what you type in the browser).

Then run:

```bash
python manage.py runssl --addr 10.1.10.123 --port 8007
```

On the phone, open the HTTPS URL once and trust/accept the certificate warning.

## Production

Use Let's Encrypt (or similar) behind nginx — see `deploy/homeboard.secboard.online.conf`.
Do not commit private keys.
