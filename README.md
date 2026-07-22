# SwiftGo

Live app: **https://swiftgo-ride-app.web.app**

Firebase project: `swiftgo-ride-app` (account: configured)

## Local

```bash
npx --yes serve . -l 5173
```

## One-time Console steps (Auth + Firestore)

1. **Auth:** https://console.firebase.google.com/project/swiftgo-ride-app/authentication/providers → enable **Email/Password**
2. **Firestore:** https://console.firebase.google.com/project/swiftgo-ride-app/firestore → Create database (production) → location e.g. `asia-south1`
3. Then run:

```bash
firebase deploy --only firestore --project swiftgo-ride-app
```

## Redeploy hosting

```bash
firebase deploy --only hosting --project swiftgo-ride-app
```
