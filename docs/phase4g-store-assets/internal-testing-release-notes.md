# Internal testing release notes — Phase 4G

Version: 1.0.0-phase4g (versionCode 10000)

- First Capacitor Android shells for Customer, Partner, Owner
- Bundled Production Hosting web assets
- Location / notification permissions wired in manifests
- Partner: background location + battery optimization permission declared
- Account deletion + Privacy/Terms available in bundled web UI
- Super Admin remains web-only (not packaged)

Known gaps for testers:
- Real `google-services.json` / FCM not attached until Firebase Android apps are created
- App Links assetlinks.json not yet hosted for autoVerify
- Store screenshots / feature graphic placeholders only
