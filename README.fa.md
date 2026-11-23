# codearts-im

> CodeArts IM Gateway · نگه‌دارنده: ThinkTom · MIT

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | **فارسی** | [Türkçe](README.tr.md) | [Español](README.es.md)

دروازه‌ای برای فرمان دادن به **Huawei Cloud CodeArts Agent** از طریق پیام‌رسان: یک پیام از گوشی بفرستید و عامل (Agent) در IDE دسکتاپ وظیفه را اجرا و نتیجه را برمی‌گرداند. کانال‌های پشتیبانی‌شده: **QQ، WeChat (iLink) و WeCom**؛ در هر زمان یک کانال فعال است و اطلاعات ورود در مخزن امن سیستم نگهداری می‌شود.

## قابلیت‌ها

- **سه کانال**: QQ (کانکتور رسمی)، WeChat iLink، WeCom (`@wecom/aibot-node-sdk`)
- **اتصال با QR**: بدون ورود دستی کلید؛ ورود دستی فقط به‌عنوان جایگزین
- **مدیریت نشست**: یک نشست هسته برای هر طرف، ذخیره و بازیابی پس از راه‌اندازی مجدد IDE
- **تحویل مطمئن**: ادغام چند مرحله، تقسیم آگاه از Markdown، محدودیت هر کانال، عقب‌نشینی در خطا
- **پاسخ جریانی**: WeCom از دلتاهای سطح توکن پشتیبانی می‌کند (گام ۶۰۰ میلی‌ثانیه)
- **تعامل انسانی**: تأیید (`1` / `2`) و پرسش (`A/B/C`)؛ فقط طرف نشست تصمیم می‌گیرد
- **فقط پاسخ نهایی**: زنجیره تفکر و پیام‌های سیستمی فیلتر می‌شوند
- **رسانه**: دریافت و رمزگشایی تصویر/فایل ورودی؛ ارسال خروجی بر اساس توان کانال
- **کنترل دسترسی**: open / allowlist / disabled، کد جفت‌شدن، لغو دسترسی، قفل تک‌نمونه
- **قابل مشاهده**: گزارش sidecar روی دیسک، بسته عیب‌یابی یک‌کلیکی (با پوشاندن داده‌های حساس)

## توان کانال‌ها

جدول توان‌ها تنها در `packages/qqbot-runtime/src/transport/capabilities.json` تعریف می‌شود.

| کانال | حداکثر نویسه | جریان | وضعیت تایپ | دکمه | رسانه | گروه |
|---|---|---|---|---|---|---|
| QQ | 4500 | — | — | — | آپلود base64 | بله (پیش‌فرض با @) |
| WeChat iLink | 1800 | — | بله | — | CDN رمزنگاری‌شده | فقط خصوصی |
| WeCom | 3500 | بله | — | پیاده‌سازی نشده | آپلود SDK | بله |

### مرزهای ارسال فایل

**ارسال فعال فایل** در هر سه کانال کار می‌کند. **ارسال خودکار فایل همراه پاسخ** فعلاً پشتیبانی نمی‌شود:

- هسته رویداد تحویل‌شدنی نمی‌فرستد (`round.artifacts.updated` تعریف شده اما ارسال نمی‌شود)؛
- مسیرهای جایگزین پیاده شده‌اند: تصویر/PDF محلی `file://` که با `browser` باز شده و نشانه‌های `![alt](path)` و `[[file:path]]`؛
- اگر کانال فایل را رد کند، پاسخ شامل `ارسال فایل ناموفق: <دلیل>` است و چیزی بی‌صدا حذف نمی‌شود.

## معماری

    QQ / WeChat iLink / WeCom
      ↕  (WebSocket / نظرسنجی طولانی HTTPS)
    sidecar (فایل اجرایی تک‌فایلی Node SEA)
      ↕ IPC محلی (لوله نام‌دار + توکن یک‌بارمصرف)
    افزونه VS Code (VSIX)
      ↕ HTTP محلی + SSE
    هسته CodeArts Agent (Session / Tools / Permission / Skills)

- اطلاعات ورود و هسته فقط روی ماشین محلی می‌مانند؛ sidecar پورت عمومی باز نمی‌کند؛
- `KernelPort` تنها مرز هسته است؛ کانال‌ها در `adapters/{qq,weixin,wecom}` قرار دارند؛
- افزونه چرخه عمر، اتصال QR، کشف پورت هسته، رمزگشایی گذرواژه و تغییر کانال را بر عهده دارد.

## سازگاری

| مورد | پشتیبانی | توضیح |
|---|---|---|
| سیستم‌عامل | Windows 10 1809+ / Windows 11 (x64) | خروجی win32-x64؛ برای macOS/Linux باید روی همان پلتفرم ساخته شود |
| CodeArts Agent | ≥ 26.11.100 | آزمایش‌شده روی 26.11.x |
| هسته عامل | 126.11.x | آزمایش‌شده روی `126.11.2-20261117200150` |
| VS Code API | `^1.109.0` | فقط APIهای پایدار |
| QQ Open Platform | Bot WebSocket API v2 | ربات آزمایشی یا رسمی |
| WeChat iLink | پروتکل 2.4.6 (`bot_type=3`) | نیازمند اسکن با WeChat موبایل |
| WeCom | WebSocket ربات هوشمند | نیازمند ربات مجاز توسط مدیر |
| Node.js (فقط توسعه) | ≥ 20.3 | برای کاربر نهایی لازم نیست |

بررسی سازگاری:

    npm run compat                      # فقط خواندن + ساخت/حذف نشست + بررسی کانال‌ها
    npm run compat -- --im wecom        # بررسی یک کانال
    npm run compat -- --with-prompt     # یک درخواست واقعی اضافه می‌کند

نتیجه در `compat-matrix.json` ذخیره و قابل درج در بسته عیب‌یابی است.

## نسخه

- نسخه فعلی: **0.4.0**
- مبنا: CodeArts Agent 26.11.100 / هسته 126.11.2
- پس از ارتقای IDE یا هسته ابتدا ماتریس سازگاری را اجرا کنید

## نصب

پیش‌نیاز: Windows x64 و CodeArts Agent 26.11.x. نصب Node.js لازم **نیست**.

    & "<مسیر CodeArts>\bin\codearts-agent.cmd" --install-extension "<مسیر>\codearts-im-0.4.0.vsix"

سپس «Developer: Reload Window» را اجرا کنید.

> پیش از ارتقا، فرایندهای قدیمی را پایان دهید: `taskkill /IM codearts-im-sidecar-win32-x64.exe /F`.

## شروع سریع

1. CodeArts Agent را اجرا و یک گفتگو کامل کنید تا هسته فعال شود؛
2. فرمان اتصال کانال را اجرا کنید:
   - «CodeArts IM: 扫码绑定QQ» برای QQ
   - «CodeArts IM: 扫码绑定微信» برای WeChat
   - «CodeArts IM: 扫码绑定企业微信» برای WeCom
3. کد QR را اسکن و در صفحه رسمی تأیید کنید؛
4. اطلاعات ورود ذخیره می‌شود، `im/channel` تغییر می‌کند و افزونه اتصال را راه‌اندازی مجدد می‌کند؛
5. در همان پیام‌رسان به ربات پیام بفرستید.

نکته: تنها یک کانال فعال است؛ برای بازگشت دوباره اسکن کنید. نخستین اجرای sidecar ۵ تا ۱۰ ثانیه طول می‌کشد و پنل به‌طور خودکار منتظر می‌ماند.

## تنظیمات

| تنظیم | پیش‌فرض | توضیح |
|---|---|---|
| `codeartsIm.enabled` | `true` | اجرای sidecar همراه IDE |
| `codeartsIm.provider` | `inferhub-provider` | ارائه‌دهنده مدل |
| `codeartsIm.model` | `deepseek-v4.1-flash-1017` | شناسه مدل؛ خالی نگذارید |
| `codeartsIm.agent` | `build` | نام عامل |
| `codeartsIm.access.c2cMode` | `open` | حالت دسترسی خصوصی |
| `codeartsIm.access.groupMode` | `allowlist` | حالت دسترسی گروه (توصیه‌شده) |
| `codeartsIm.textChunkLimit` | `4500` | حداکثر نویسه هر پیام (محدودیت کانال اولویت دارد) |
| `codeartsIm.media.maxMB` | `200` | محدودیت رسانه ورودی |
| `codeartsIm.sendFile.restrict` | `true` | محدودکردن مسیر فایل خروجی |

## فرمان‌ها

`/new`، `/compact`، `/model`، `/stop`، `/allow`، `/deny`، `/bot-status`، `/bot-ping`، `/bot-help`.

## امنیت و داده

- AppSecret / توکن WeChat / secret WeCom فقط در مخزن امن یا حافظه می‌مانند؛
- گذرواژه هسته با رمزگشایی فقط‌خواندنی از مخزن رسمی خوانده می‌شود؛
- فایل خروجی با فهرست سفید فضای کاری (`realpath`) بررسی می‌شود، حداکثر ۲۰ مگابایت؛
- گزارش‌ها و بسته عیب‌یابی، کلیدها و توکن‌ها را پوشانده (`[REDACTED]`) می‌کنند؛
- فقط پاسخ نهایی ارسال می‌شود؛ جزئیات: [PRIVACY.md](PRIVACY.md).

## عیب‌یابی

- گزارش: `<globalStorage>/codearts-community.codearts-im/codearts-im/logs/sidecar.log` (۴ مگابایت × ۵)
- خروجی: «CodeArts IM: 导出诊断包» شامل وضعیت، لوله IPC، تنظیمات، ۳۰۰ خط گزارش و ماتریس سازگاری
- پنل خروجی: `CodeArts IM`

## ساخت

    npm install
    npm run check            # لایه‌ها / نوع‌ها / آزمون‌ها (۲۱۲)
    npm run build:sidecar    # فایل اجرایی Node SEA
    npm run package:vsix     # ساخت VSIX

## اجزای متن‌باز

| جزء | نسخه | کاربرد | مجوز |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | اتصال QR و WebSocket QQ | **UNLICENSED** (اختصاصی Tencent) |
| `@wecom/aibot-node-sdk` | 1.0.7 | WebSocket / جریان / رسانه WeCom | شرایط بسته |
| `qrcode` | 1.5.4 | رندر QR | MIT |
| `esbuild` | 0.24.x | بسته‌بندی | MIT |
| `TypeScript` | 5.x | نوع‌ها و ساخت | Apache-2.0 |
| `Vitest` | 2.1.x | آزمون واحد | MIT |
| `tsx` | 4.23.x | اجرای TypeScript | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | مرجع پروتکل WeChat/WeCom | MIT |
| CodeArts Agent / Kernel | 26.11.x / 126.11.x | میزبان و هسته | شرایط Huawei Cloud |

> **هشدار توزیع**: `@tencent-connect/qqbot-connector` با UNLICENSED مشخص شده است؛ پیش از توزیع بسته، شرایط Tencent را بررسی کنید. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## محدودیت‌ها

- فقط خروجی Windows x64؛
- وابستگی شدید به نسخه CodeArts Agent و هسته؛
- QQ: پنجره پاسخ غیرفعال حدود ۵ دقیقه و حداکثر ۵ پاسخ؛
- WeChat iLink: فقط گفتگوی خصوصی؛ `ret=-14` نیازمند اسکن مجدد؛
- WeCom: کارت‌های دکمه‌ای پیاده‌سازی نشده، تعامل متنی است؛
- گروه‌ها به‌طور پیش‌فرض allowlist؛
- ارسال خودکار فایل محدود به سیاست پلتفرم است.

## مشارکت

Issue و Pull Request پذیرفته می‌شود. `npm run check` باید موفق باشد، منطق جدید آزمون داشته باشد و پیام commit «چرا» را توضیح دهد.

## مستندات

[PRIVACY.md](PRIVACY.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [TODO.md](TODO.md) · docs/

## مجوز

MIT License، `Copyright (c) 2026 ThinkTom`. متن کامل: [LICENSE](LICENSE).