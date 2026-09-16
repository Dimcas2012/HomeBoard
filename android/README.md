# HomeBoard Camera (Android)

Мобільний клієнт-камера для [homeboard.secboard.online](https://homeboard.secboard.online).

## Можливості

- Сервер за замовчуванням: `https://homeboard.secboard.online`
- Pairing-код з веб-кабінету (Камери → Створити код)
- WebView + WebRTC `/camera/` (прев’ю, motion, запис)
- Збереження credentials на пристрої
- Ліхтарик і економ-режим (екран затемнено, стрім працює)
- **Talkback:** звук з Viewer (🎤) відтворюється на динаміках телефону
- **AI-аналітика:** кадри на сервер (YOLO), опційний on-device prefilter (TF.js), індикатор AI у шапці

## Збірка в Android Studio

1. Відкрийте папку `android/` як проєкт
2. Sync Gradle
3. Run на телефоні/емуляторі (API 26+)

```bash
cd android
./gradlew :app:assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

Версія: **1.2.2** (`versionCode` 8)

## Використання

1. У браузері на ПК: увійдіть на `https://homeboard.secboard.online` → **Камери** → **Створити код**
2. У додатку введіть код → **Підключити**
3. На сторінці камери натисніть **Старт стріму** (у додатку стартує автоматично)
4. На ПК відкрийте **Viewer**
5. **Говорити на телефон:** у плитці камери натисніть **🎤** (або в панелі керування) — дозвольте мікрофон у браузері; звук піде на динаміки телефону (індикатор «Viewer» у шапці додатку)
6. AI: у кабінеті **AI** увімкніть аналітику для камери. Опція «on-device» грузить легку модель у WebView і шле кадр лише коли є цікавий клас.

## Сервер

На бекенді мають бути в `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS`:

- `homeboard.secboard.online`
- `https://homeboard.secboard.online`
