# Kanakku

A private, fully offline money tracker for Android: expenses, income, bank accounts (AED & INR),
money lent and borrowed, kuri, investments and property, with recurring entries and reports.

- `web/` – the app (plain HTML/CSS/JS, no network access)
- `android/` – a thin WebView wrapper; GitHub Actions builds a signed APK on every push to `main`
  and publishes it under **Releases**
- `tools/` – developer scripts for testing the Vyapar importer

Your data lives only on your phone. Use *Settings → Save backup* regularly.
