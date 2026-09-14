# HomeBoard Camera (Android)

Мобільний клієнт-камера для [homeboard.secboard.online](https://homeboard.secboard.online).

## Можливості

- Сервер за замовчуванням: `https://homeboard.secboard.online`
- Pairing-код з веб-кабінету (Камери → Створити код)
- WebView + WebRTC `/camera/` (прев’ю, motion, запис)
- Збереження credentials на пристрої

## Збірка в Android Studio

1. Відкрийте папку `android/` як проєкт
2. Sync Gradle
3. Run на телефоні/емуляторі (API 26+)

```bash
cd android
./gradlew :app:assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## Використання

1. У браузері на ПК: увійдіть на `https://homeboard.secboard.online` → **Камери** → **Створити код**
2. У додатку введіть код → **Підключити**
3. На сторінці камери натисніть **Старт стріму**
4. На ПК відкрийте **Viewer**

## Сервер

На бекенді мають бути в `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS`:

- `homeboard.secboard.online`
- `https://homeboard.secboard.online`
