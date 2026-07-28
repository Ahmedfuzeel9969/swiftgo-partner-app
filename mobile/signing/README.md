# Release signing (never commit secrets)

1. Create a keystore offline (example):

```bash
keytool -genkeypair -v -keystore swiftgo-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias swiftgo-upload
```

2. Copy `keystore.properties.example` → `keystore.properties` (gitignored) and fill paths/passwords.

3. Wire into each app `android/app/build.gradle` signingConfigs (see `tools/phase4g-apply-android-hardening.mjs`).

4. Build AAB:

```bash
npm run android:aab:customer
```

Upload keystore only to Play App Signing / secure vault — never to git.
