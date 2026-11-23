# codearts-im

> CodeArts IM Gateway · Bakım: ThinkTom · MIT

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | **Türkçe** | [Español](README.es.md)

Telefonunuzdan yerel **Huawei Cloud CodeArts Agent**'ı yöneten IM ağ geçidi. Desteklenen kanallar: **QQ, WeChat (iLink) ve WeCom (kurumsal WeChat)**. Aynı anda tek kanal etkindir; kimlik bilgileri sistemin gizli deposunda tutulur.

## Özellikler

- **Üç kanal**: QQ (resmî bağlayıcı), WeChat iLink, WeCom (`@wecom/aibot-node-sdk`)
- **QR ile bağlama**: tüm kanallarda tarama ile; elle giriş yalnızca yedek
- **Oturum yönetimi**: her karşı taraf için ayrı çekirdek oturumu, kalıcı eşleme, IDE yeniden başlatınca devam
- **Güvenilir teslim**: çok adımlı birleştirme, Markdown'a duyarlı bölme, kanal limitleri, hata durumunda geri düşme
- **Akış**: WeCom token düzeyinde delta destekler (600 ms kısıtlama, ACK gecikince atlama)
- **İnsan döngüsü**: onay (`1` / `2`) ve soru (`A/B/C`); yalnızca oturum karşı tarafı karar verir
- **Yalnızca nihai yanıt**: düşünce zinciri ve sistem istemleri filtrelenir
- **Medya**: gelen görsel/dosya indirme ve şifre çözme; giden yükleme kanal yeteneğine göre
- **Erişim kontrolü**: open / allowlist / disabled, eşleştirme kodu, iptal, tek örnek kilidi
- **Gözlemlenebilirlik**: diskte sidecar günlüğü, tek tıkla tanılama paketi (maskelenmiş, uyumluluk matrisi dahil)

## Kanal yetenekleri

Yetenek tablosu tek kaynaktan gelir: `packages/qqbot-runtime/src/transport/capabilities.json`.

| Kanal | Maks. karakter | Akış | Yazıyor | Düğme | Medya | Grup |
|---|---|---|---|---|---|---|
| QQ | 4500 | — | — | — | base64 yükleme | Evet (varsayılan @) |
| WeChat iLink | 1800 | — | Evet | — | şifreli CDN | Yalnızca birebir |
| WeCom | 3500 | Evet | — | Uygulanmadı | SDK medya yükleme | Evet |

### Dosya gönderim sınırları

**Proaktif dosya gönderimi** üç kanalda da çalışır. **Yanıtla birlikte otomatik dosya gönderimi** henüz desteklenmiyor:

- çekirdek teslim edilebilir olayı göndermiyor (`round.artifacts.updated` tanımlı ama çalışmıyor);
- yedek yollar uygulandı: `browser` ile açılan yerel `file://` görsel/PDF ve `![alt](path)`, `[[file:path]]` işaretleri;
- kanal dosyayı reddederse yanıtta `dosya gönderilemedi: <neden>` döner; sessiz kayıp olmaz.

## Mimari

    QQ / WeChat iLink / WeCom
      ↕  (WebSocket / HTTPS uzun sorgu)
    sidecar (tek dosya Node SEA çalıştırılabilir)
      ↕ yerel IPC (adlandırılmış kanal + tek kullanımlık token)
    VS Code eklentisi (VSIX)
      ↕ yerel HTTP + SSE
    CodeArts Agent çekirdeği (Session / Tools / Permission / Skills)

- Kimlik bilgileri ve çekirdek yerelde kalır; sidecar genel port açmaz;
- `KernelPort` tek çekirdek sınırıdır; kanallar `adapters/{qq,weixin,wecom}` altında;
- Eklenti yaşam döngüsü, QR bağlama, çekirdek port keşfi, parola çözme ve kanal değiştirmeyi üstlenir.

## Uyumluluk

| Öğe | Destek | Not |
|---|---|---|
| İşletim sistemi | Windows 10 1809+ / Windows 11 (x64) | Çıktı win32-x64; macOS/Linux hedefte derlenmeli |
| CodeArts Agent | ≥ 26.11.100 | 26.11.x üzerinde doğrulandı |
| Agent çekirdeği | 126.11.x | `126.11.2-20261117200150` üzerinde doğrulandı |
| VS Code API | `^1.109.0` | Yalnızca kararlı API'ler |
| QQ Open Platform | Bot WebSocket API v2 | Test veya üretim botu |
| WeChat iLink | Protokol 2.4.6 (`bot_type=3`) | Mobil WeChat ile tarama gerekir |
| WeCom | Akıllı bot WebSocket | Yönetici tarafından yetkilendirilmiş bot gerekir |
| Node.js (yalnızca geliştirme) | ≥ 20.3 | Son kullanıcı için gerekmez |

Uyumluluk kontrolü:

    npm run compat                      # salt okunur + oturum + kanal kontrolleri
    npm run compat -- --im wecom        # tek kanalı doğrula
    npm run compat -- --with-prompt     # bir gerçek çıkarım ekler

Sonuç `compat-matrix.json` dosyasına yazılır ve tanılama paketine eklenebilir.

## Sürüm

- Güncel: **0.4.0**
- Taban: CodeArts Agent 26.11.100 / çekirdek 126.11.2
- IDE veya çekirdek yükseltmesinden sonra önce uyumluluk matrisini çalıştırın

## Kurulum

Gereksinimler: Windows x64, CodeArts Agent 26.11.x. Node.js **gerekmez**.

    & "<CodeArts dizini>\bin\codearts-agent.cmd" --install-extension "<yol>\codearts-im-0.4.0.vsix"

Ardından «Developer: Reload Window» çalıştırın.

> Yükseltmeden önce eski süreçleri kapatın: `taskkill /IM codearts-im-sidecar-win32-x64.exe /F`.

## Hızlı başlangıç

1. CodeArts Agent'ı başlatın ve bir görüşme tamamlayın;
2. İlgili kanal bağlama komutunu çalıştırın:
   - «CodeArts IM: 扫码绑定QQ» (QQ)
   - «CodeArts IM: 扫码绑定微信» (WeChat)
   - «CodeArts IM: 扫码绑定企业微信» (WeCom)
3. QR kodu tarayın ve resmî sayfada onaylayın;
4. Kimlik bilgileri gizli depoya yazılır, `im/channel` değişir ve eklenti bağlantıyı yeniden başlatır;
5. İlgili IM'de bota mesaj gönderin.

Notlar: aynı anda tek kanal etkindir; geri dönmek için yeniden tarayın. İlk sidecar başlangıcı 5–10 s sürer; bağlama paneli otomatik bekler.

## Ayarlar

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `codeartsIm.enabled` | `true` | Sidecar'ı IDE ile başlat |
| `codeartsIm.provider` | `inferhub-provider` | Model sağlayıcı |
| `codeartsIm.model` | `deepseek-v4.1-flash-1017` | Model kimliği; boş bırakmayın |
| `codeartsIm.agent` | `build` | Agent adı |
| `codeartsIm.access.c2cMode` | `open` | Birebir erişim modu |
| `codeartsIm.access.groupMode` | `allowlist` | Grup erişim modu (önerilir) |
| `codeartsIm.textChunkLimit` | `4500` | Mesaj başına maks. karakter (kanal limiti önceliklidir) |
| `codeartsIm.media.maxMB` | `200` | Gelen medya sınırı |
| `codeartsIm.sendFile.restrict` | `true` | Giden dosya yollarını kısıtla |

## Komutlar

`/new`, `/compact`, `/model`, `/stop`, `/allow`, `/deny`, `/bot-status`, `/bot-ping`, `/bot-help`.

## Güvenlik ve veri

- AppSecret / WeChat token / WeCom secret yalnızca gizli depoda veya bellekte;
- Çekirdek parolası resmî şifreli depodan salt okunur çözülür, elle giriş yedek;
- Giden dosyalar çalışma alanı beyaz listesiyle (`realpath`) doğrulanır, dosya başına 20 MB;
- Günlükler ve tanılama, gizli değerleri `[REDACTED]` ile maskeler;
- Yalnızca nihai yanıt IM'e gider; ayrıntılar: [PRIVACY.md](PRIVACY.md).

## Tanılama

- Günlük: `<globalStorage>/codearts-community.codearts-im/codearts-im/logs/sidecar.log` (4 MB × 5)
- Dışa aktarma: «CodeArts IM: 导出诊断包» — eklenti/sidecar durumu, IPC kanalı, ayar özeti, son 300 satır ve uyumluluk matrisi
- Çıktı paneli: `CodeArts IM`

## Derleme

    npm install
    npm run check            # katmanlar / tipler / testler (212)
    npm run build:sidecar    # Node SEA tek dosya
    npm run package:vsix     # VSIX üret

## Açık kaynak bileşenler

| Bileşen | Sürüm | Amaç | Lisans |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ QR bağlama, WebSocket | **UNLICENSED** (Tencent) |
| `@wecom/aibot-node-sdk` | 1.0.7 | WeCom WebSocket / akış / medya | paket koşulları |
| `qrcode` | 1.5.4 | QR çizimi | MIT |
| `esbuild` | 0.24.x | Paketleme | MIT |
| `TypeScript` | 5.x | Tipler ve derleme | Apache-2.0 |
| `Vitest` | 2.1.x | Birim testleri | MIT |
| `tsx` | 4.23.x | TypeScript çalıştırma | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | WeChat/WeCom protokol referansı | MIT |
| CodeArts Agent / Kernel | 26.11.x / 126.11.x | Ana makine ve çekirdek | Huawei Cloud koşulları |

> **Dağıtım notu**: `@tencent-connect/qqbot-connector` UNLICENSED. Paketlemeden önce Tencent koşullarını doğrulayın. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Bilinen sınırlar

- Yalnızca Windows x64 çıktı;
- CodeArts Agent/çekirdek sürümlerine sıkı bağımlılık;
- QQ: yaklaşık 5 dakikalık pasif yanıt penceresi, mesaj başına en fazla 5 yanıt;
- WeChat iLink: yalnızca birebir; `ret=-14` yeniden tarama gerektirir;
- WeCom: düğmeli kartlar uygulanmadı, metin etkileşimi kullanılıyor;
- Gruplar varsayılan olarak allowlist;
- Otomatik dosya gönderimi platform politikasıyla sınırlı.

## Katkı

Issue ve Pull Request memnuniyetle karşılanır. `npm run check` geçmeli, yeni mantık test edilmeli ve commit mesajı «neden»i açıklamalıdır.

## Belgeler

[PRIVACY.md](PRIVACY.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [TODO.md](TODO.md) · docs/

## Lisans

MIT License, `Copyright (c) 2026 ThinkTom`. Tam metin: [LICENSE](LICENSE).