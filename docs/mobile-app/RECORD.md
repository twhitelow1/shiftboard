# Mobile app record: IDs, status and log

Filled in by the agents and the owner while following [REGISTRATION-RUNBOOK.md](REGISTRATION-RUNBOOK.md).

> **No secrets here. Ever.** No passwords, 2FA or recovery codes, card or bank numbers, tax IDs, API keys, access tokens, or key files (`.p8`, `.p12`, keystores, service account `.json`), and no screenshots of them.
> Secrets live in:
> - **EAS credentials** (expo.dev → project → Credentials): iOS distribution certificate, provisioning profile, APNs key, App Store Connect API key; Android upload keystore, FCM v1 service account key, Play submission service account key.
> - **EAS environment variables** (file type): `GOOGLE_SERVICES_JSON`.
> - **Vercel environment variables** (per deployment, marked Sensitive): `JWT_SECRET`, `RESEND_API_KEY`, and `EXPO_ACCESS_TOKEN` only if enhanced push security is on.
> - **DubLow's password manager**: account passwords, the App Review demo password, recovery codes.

## Identifiers and status

| Item | Value | Status | Date | Who |
|---|---|---|---|---|
| Legal entity name | | | | |
| D-U-N-S on file (yes/no) | | | | |
| D-U-N-S number | | | | |
| Apple Account (email used, no password) | | | | |
| Apple Developer Program enrollment ID | | | | |
| Apple Team ID | | | | |
| Apple membership renews on | | | | |
| EU trader status declared (yes/no, answer) | | | | |
| iOS bundle ID | `com.dublowdigital.shiftboard` | not registered | | |
| Store name (final) | | not decided (see DECISION.md "Name risk") | | |
| App Store Connect app ID (Apple ID, number) | | | | |
| App Store Connect SKU | `shiftboard-ios-001` | | | |
| APNs key ID (key itself stays in EAS) | | | | |
| App Store Connect API key ID (key stays in EAS) | | | | |
| Google Play developer account ID | | | | |
| Play account type | Organization | | | |
| Play package name | `com.dublowdigital.shiftboard` | | | |
| Play internal testing list | | | | |
| Firebase project ID | | | | |
| FCM v1 key in EAS (yes/no) | | | | |
| Play submissions service account (email) | | | | |
| Expo organization / account | | | | |
| EAS project slug | `shiftboard` | | | |
| EAS project ID | | | | |
| Privacy policy URL (stable, DubLow) | | draft, not reviewed | | |
| Support URL | | draft, not reviewed | | |
| Data deletion URL | | | | |
| Review demo restaurant URL | | | | |
| Review demo account (username only) | | | | |
| First iOS build (version / build number) | | | | |
| First Android build (version / version code) | | | | |
| TestFlight internal testing | | | | |
| Play internal testing release | | | | |

## Log

Newest last. One line per step or STOP: date, who (agent / owner / developer), what was done, what's next.

| Date | Who | What | Next |
|---|---|---|---|
| 2026-11-21 | developer (Claude) | Built the first version of the app (`mobile/`), server support, docs and draft privacy/support pages. No accounts created yet. | Owner: pick the store name; review privacy/support drafts; start section 1 (D-U-N-S). |
