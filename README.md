# Nahan on Node (نهان) — نسخه Node.js

پنل نهان v3.0.4 (itsyebekhe/nahan) بدون تغییر در کد اصلی، روی Node.js.
به دلیل باگ ۱۱۰۱ در runtime اکانت Cloudflare، به جای Workers روی Node اجرا می‌شود.

## اجرای محلی

```bash
npm install
node server.js
# پنل: http://127.0.0.1:8787/sync/dash
```

## استقرار روی Render

1. این پوشه را در یک ریپوی گیت‌هابpush کنید (یا در Render از "Deploy from folder" استفاده کنید)
2. New + → Blueprint → ریپو را انتخاب کنید
3. render.yaml خودکار: سرویس web + دیسک ۱ گیگ برای دیتابیس
4. بعد از دیپلوی: `https://<app>.onrender.com/sync/dash`

## ساختار

- `_worker.js` — کد اصلی و دست‌نخورده نهان v3.0.4
- `cfshim.mjs` — لایه سازگاری Cloudflare→Node (WebSocketPair, connect, D1-on-SQLite, waitUntil)
- `cfshim_sockets.mjs` — re-export برای import `cloudflare:sockets`
- `server.js` — سرور HTTP + WebSocket + کرون ۱۵ دقیقه‌ای
- دیتابیس: SQLite در مسیر `DB_PATH` (روی Render: volume `/app/data`)

## اولین ورود

- مسیر: `/sync/dash`
- رمز پیش‌فرض: `Nahan1400!` (در دیتابیس تزریق شده — بعد از ورود از تب System عوضش کن)
