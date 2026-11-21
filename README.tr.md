# codearts-im

> CodeArts IM Gateway · Sürdüren: ThinkTom

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | **Türkçe** | [Español](README.es.md)

Yerel **Huawei Cloud CodeArts Agent**'ı QQ üzerinden yöneten bir IM geçidi (WeChat / WeCom yol haritasında). Telefonunuzdan tek mesaj gönderin; masaüstü IDE'deki Agent görevi yürütüp sonucu geri döndürsün.

## Özellikler

- **QR ile bağlama**: resmî Tencent bağlayıcısıyla bot oluşturma/bağlama — AppID/AppSecret elle girilmez
- **İki sohbet modu**: özel mesaj ve grupta bahsetme (varsayılan olarak @ gerekir)
- **Oturum yönetimi**: her karşı taraf için ayrı çekirdek oturumu, kalıcı eşleme, IDE yeniden başlatıldığında otomatik devam
- **Güvenilir teslim**: akış deltaları, çok adımlı yanıtların birleştirilmesi, Markdown'a duyarlı bölme, `msg_seq` sınırlaması ve geri düşüş
- **İnsan katılımı**: onaylar (`1` / `2`) ve sorular (`A/B/C`)
- **Yalnızca nihai yanıt**: düşünce zinciri ve sistem istemleri filtrelenir
- **Medya**: gelen görsel/dosya indirme ve şifre çözme, giden dosya gönderimi (metin yoluna geri düşüş)
- **Erişim kontrolü**: open / allowlist / disabled, eşleştirme kodu, iptal listesi, tek örnek kilidi
- **Doğrulanabilir**: `npm run compat` çekirdek uyumluluk matrisi ile yükseltme sonrası regresyon

## Mimari

    QQ Open Platform (WebSocket)
      ↕
    sidecar (tek Node SEA çalıştırılabilir dosyası)
      ↕ yerel IPC (adlandırılmış kanal + tek kullanımlık token)
    VS Code eklentisi (VSIX)
      ↕ yerel HTTP + SSE
    CodeArts Agent Kernel (Session / Tools / Permission / Skills)

- Kimlik bilgileri ve çekirdek yalnızca yerel makinede kalır; sidecar genel bir port açmaz;
- `KernelPort` çekirdekle tek sınırdır; QQ taşıma katmanı `adapters/qq` içindedir;
- Eklenti yaşam döngüsü, QR bağlama, çekirdek portu keşfi ve parola çözümünü yönetir.

## Uyumluluk

| Öğe | Destek | Not |
|---|---|---|
| İşletim sistemi | Windows 10 1809+ / Windows 11 (x64) | Yayımlanan paket win32-x64; macOS/Linux hedef platformda derlenmeli |
| CodeArts Agent | ≥ 26.11.100 | 26.11.x üzerinde doğrulandı |
| Agent Kernel | 126.11.x | `126.11.2-20261117200150` üzerinde doğrulandı |
| VS Code API | `^1.109.0` | Yalnızca kararlı API'ler |
| QQ Open Platform | Bot WebSocket API v2 | Sandbox veya üretim botu |
| Node.js (yalnızca geliştirme) | ≥ 20.3 | Son kullanıcı gerekmez; runtime sidecar içinde gelir |

Uyumluluk kontrolleri:

    npm run compat                    # salt okunur + oturum oluştur/sil
    npm run compat -- --with-prompt   # bir gerçek çıkarım ekler (az kota tüketir)

## Sürüm

- Güncel sürüm: **0.3.2** (anlamsal sürümleme; 0.x dalında arayüzler değişebilir)
- Uyumluluk temeli: CodeArts Agent 26.11.100 / Kernel 126.11.2
- Yükseltme politikası: IDE veya çekirdek yükseltmesinden sonra önce uyumluluk matrisini çalıştırın
- Değişiklik geçmişi: commit geçmişi ve `output/` altındaki tasarım belgeleri

## Kurulum

Gereksinimler: Windows x64, CodeArts Agent 26.11.x. Node.js **gerekmez**.

    & "<CodeArts kurulum dizini>\bin\codearts-agent.cmd" --install-extension "<yol>\codearts-qqbot-cn-0.3.2.vsix"

Alternatif olarak Uzantılar görünümünde “Install from VSIX” kullanın, ardından “Developer: Reload Window” çalıştırın.

## Hızlı başlangıç

1. CodeArts Agent'ı başlatın ve çekirdeğin çalışması için bir sohbet tamamlayın;
2. Komut Paleti → “QQ Bot: 扫码绑定机器人” (QR ile bağla);
3. Resmî QR kodunu mobil QQ ile tarayın ve Tencent sayfasında oluşturma/bağlamayı tamamlayın;
4. Kimlik bilgileri sistem gizli deposuna yazılır ve bağlantı otomatik yeniden başlar;
5. Bota özel mesaj gönderin.

Tarama kullanılamıyorsa “QQ Bot: 手动填写凭据” (elle giriş) yedeği vardır.

## Yapılandırma

| Ayar | Varsayılan | Açıklama |
|---|---|---|
| `codeartsQqbot.provider` | `inferhub-provider` | Model sağlayıcısı |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | Model kimliği — boş bırakmayın |
| `codeartsQqbot.agent` | `build` | Kullanılacak Agent |
| `codeartsQqbot.access.c2cMode` | `open` | Özel mesaj erişim modu |
| `codeartsQqbot.access.groupMode` | `allowlist` | Grup erişim modu (üretimde koruyun) |
| `codeartsQqbot.textChunkLimit` | `4500` | Mesaj başına en fazla karakter |
| `codeartsQqbot.media.maxMB` | `200` | Gelen medya boyut sınırı |
| `codeartsQqbot.sendFile.restrict` | `true` | Giden dosya yollarını kısıtla |

## Komutlar

| Komut | Amaç |
|---|---|
| `/new` | Yeni oturum |
| `/compact` | Bağlamı sıkıştır |
| `/model` | Modeli göster / değiştir |
| `/stop` | Geçerli turu durdur |
| `/allow`, `/deny` | İsteği onayla / reddet |
| `/bot-status`, `/bot-ping`, `/bot-help` | Durum, gecikme, yardım |

## Güvenlik ve veriler

- AppSecret ve çekirdek parolası yalnızca sistem gizli deposunda veya bellekte tutulur — yapılandırmada, depoda veya günlüklerde değil;
- Çekirdek parolası resmî şifreli depodan salt okunur olarak çözülür; başarısız olursa elle girişe dönülür;
- Giden dosyalar `realpath` izin listeleriyle (çalışma alanı + medya) doğrulanır, dosya başına 20 MB;
- Günlükler ve tanılama paketi sırları, token'ları ve openid'leri maskeler;
- Yalnızca nihai yanıt gönderilir; düşünce zinciri ve sistem istemleri QQ'ya ulaşmaz.

## Derleme

Geliştirme ortamı: Windows x64, Node.js ≥ 20.3, entegrasyon için CodeArts Agent 26.11.x.

    npm install
    npm run check            # katman kuralları / tipler / birim testleri
    npm run build:sidecar    # Node SEA tek çalıştırılabilir dosya
    npm run package:vsix     # eklentiyi derle ve VSIX paketle

## Açık kaynak bileşenler ve teşekkürler

| Bileşen | Sürüm | Amaç | Lisans |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | QQ QR bağlama ve WebSocket bağlantısı | **UNLICENSED** (Tencent'e özel; kendi koşullarına tabidir) |
| `qrcode` | 1.5.4 | QR görselleştirme | MIT |
| `esbuild` | 0.24.x | Paketleme | MIT |
| `TypeScript` | 5.x | Tip sistemi ve derleme | Apache-2.0 |
| `Vitest` | 2.1.x | Birim testleri | MIT |
| `tsx` | 4.23.x | Geliştirmede TypeScript çalıştırma | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | WeChat/WeCom protokol referansı (doğrudan bağımlılık değil) | MIT |
| CodeArts Agent / Agent Kernel | 26.11.x / 126.11.x | Ana makine ve çekirdek | Huawei Cloud ürün koşulları |

Teşekkürler: Tencent QQ Open Platform ve DeepSeek Harness topluluğu (`dsh-qqbot`, `dsh-im`) — protokol ve etkileşim konusundaki kamuya açık uygulamaları için.

> **Dağıtım notu**: `@tencent-connect/qqbot-connector` UNLICENSED olarak işaretlidir. Paketlenmiş VSIX/sidecar dağıtımından önce Tencent lisans koşullarını doğrulayın.

## Bilinen sınırlamalar

- Yalnızca Windows x64 paketleri; diğer platformlar için yerel derleme gerekir;
- CodeArts Agent/çekirdek sürümlerine sıkı bağlı — yükseltme sonrası regresyon testi gerekir;
- QQ pasif yanıt penceresi yaklaşık 5 dakika ve mesaj başına en fazla 5 yanıt;
- Gruplar varsayılan olarak allowlist; `open` yalnızca yerel entegrasyon içindir;
- Onay ve sorular metin tabanlıdır (sayı/harf); düğme kartları henüz uygulanmadı.

## Sorun giderme

“CodeArts QQ Bot” çıktı kanalını açın ve günlük işaretlerini izleyin:

| Günlük | Anlam |
|---|---|
| `sidecar binary not found` | VSIX içinde `bin/` yok; yeniden kurun |
| `ipc bridge connected` | Eklenti ve sidecar bağlandı |
| `已从码道加密存储获取内核口令` | Çekirdek parolası otomatik alındı |
| `sidecar running` / `qq bot ready` | Hizmet ve QQ bağlantısı hazır |
| `qq message received` | Gelen QQ mesajı alındı |
| `inbound accepted` / `kernel prompt sending` | Çekirdeğe iletildi |
| `reply sending` / `outbound send failed` | Gönderim sonucu ve hata nedeni |

## Katkı

Issue ve Pull Request memnuniyetle karşılanır. `npm run check` geçmeli, yeni mantık için test eklenmeli ve commit mesajı değişikliğin **nedenini** açıklamalıdır.

## Lisans

Proje kodu **MIT License** ile lisanslanmıştır. Üçüncü taraf bileşenler kendi lisanslarını korur; `@tencent-connect/qqbot-connector` UNLICENSED'dır — yeniden dağıtımdan önce yetkiyi doğrulayın.