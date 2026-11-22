# codearts-im

> CodeArts IM Gateway · Mantenedor: ThinkTom · MIT

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Türkçe](README.tr.md) | **Español**

Pasarela IM para controlar el **Huawei Cloud CodeArts Agent** local desde el teléfono. Canales compatibles: **QQ, WeChat (iLink) y WeCom (WeChat corporativo)**. Solo un canal está activo a la vez; las credenciales se guardan en el almacén seguro del sistema.

## Funciones

- **Tres canales**: QQ (conector oficial), WeChat iLink y WeCom (`@wecom/aibot-node-sdk`)
- **Vinculación por QR**: sin introducir claves a mano; la entrada manual es solo un respaldo
- **Gestión de sesiones**: una sesión del núcleo por interlocutor, mapeo persistente, reanudación tras reiniciar el IDE
- **Entrega fiable**: unión de varios pasos, división según Markdown y límites del canal, degradación ante errores
- **Respuestas en streaming**: WeCom admite deltas a nivel de token (limitados a 600 ms)
- **Interacción humana**: aprobaciones (`1` / `2`) y preguntas (`A/B/C`); solo el interlocutor de la sesión decide
- **Solo la respuesta final**: se filtran la cadena de razonamiento y los avisos del sistema
- **Medios**: descarga y descifrado de imágenes/archivos entrantes; subida según la capacidad del canal
- **Control de acceso**: open / allowlist / disabled, códigos de emparejamiento, revocación, bloqueo de instancia única
- **Observabilidad**: registro del sidecar en disco y paquete de diagnóstico de un clic (con datos enmascarados)

## Capacidades por canal

La tabla se define una sola vez en `packages/qqbot-runtime/src/transport/capabilities.json`.

| Canal | Máx. caracteres | Streaming | Escribiendo | Botones | Medios | Grupos |
|---|---|---|---|---|---|---|
| QQ | 4500 | — | — | — | subida base64 | Sí (con @ por defecto) |
| WeChat iLink | 1800 | — | Sí | — | CDN cifrado | Solo directo |
| WeCom | 3500 | Sí | — | No implementado | subida vía SDK | Sí |

### Límites de envío de archivos

El **envío proactivo de archivos** funciona en los tres canales. El **envío automático junto con la respuesta** aún no está soportado:

- el núcleo no emite eventos de entrega (`round.artifacts.updated` está definido pero no se envía);
- hay respaldos implementados: imágenes/PDF locales `file://` abiertos con `browser` y marcadores `![alt](path)`, `[[file:path]]`;
- si el canal rechaza el archivo, la respuesta incluye `no se pudo enviar el archivo: <motivo>`; nunca se pierde en silencio.

## Arquitectura

    QQ / WeChat iLink / WeCom
      ↕  (WebSocket / sondeo largo HTTPS)
    sidecar (binario único Node SEA)
      ↕ IPC local (tubería con nombre + token de un solo uso)
    Extensión de VS Code (VSIX)
      ↕ HTTP local + SSE
    Núcleo CodeArts Agent (Session / Tools / Permission / Skills)

- Las credenciales y el núcleo permanecen en la máquina local; el sidecar no abre puertos públicos;
- `KernelPort` es el único límite con el núcleo; los canales viven en `adapters/{qq,weixin,wecom}`;
- La extensión gestiona el ciclo de vida, la vinculación QR, el descubrimiento del puerto, el descifrado y el cambio de canal.

## Compatibilidad

| Elemento | Soporte | Nota |
|---|---|---|
| Sistema | Windows 10 1809+ / Windows 11 (x64) | El artefacto es win32-x64; macOS/Linux deben compilarse en su plataforma |
| CodeArts Agent | ≥ 26.11.100 | Probado en 26.11.x |
| Núcleo del agente | 126.11.x | Probado en `126.11.2-20261117200150` |
| API de VS Code | `^1.109.0` | Solo API estables |
| QQ Open Platform | Bot WebSocket API v2 | Bot de pruebas o producción |
| WeChat iLink | Protocolo 2.4.6 (`bot_type=3`) | Requiere escanear con WeChat móvil |
| WeCom | WebSocket de bot inteligente | Requiere un bot autorizado por el administrador |
| Node.js (solo desarrollo) | ≥ 20.3 | El usuario final no lo necesita |

Comprobaciones de compatibilidad:

    npm run compat                      # solo lectura + sesión + canales
    npm run compat -- --im wecom        # validar un canal
    npm run compat -- --with-prompt     # añade una inferencia real (consume cuota)

El resultado se escribe en `compat-matrix.json` y puede incluirse en el paquete de diagnóstico.

## Versión

- Actual: **0.3.2**
- Base: CodeArts Agent 26.11.100 / núcleo 126.11.2
- Tras actualizar el IDE o el núcleo, ejecute primero la matriz de compatibilidad

## Instalación

Requisitos: Windows x64 y CodeArts Agent 26.11.x. Node.js **no** es necesario.

    & "<directorio de CodeArts>\bin\codearts-agent.cmd" --install-extension "<ruta>\codearts-qqbot-cn-0.3.2.vsix"

Después ejecute «Developer: Reload Window».

> Antes de actualizar, cierre procesos antiguos: `taskkill /IM qqbot-sidecar-win32-x64.exe /F`.

## Inicio rápido

1. Inicie CodeArts Agent y complete una conversación para que el núcleo esté activo;
2. Ejecute el comando de vinculación del canal:
   - «QQ Bot: 扫码绑定机器人» (QQ)
   - «QQ Bot: 扫码绑定微信» (WeChat)
   - «QQ Bot: 扫码绑定企业微信» (WeCom)
3. Escanee el código QR y confirme en la página oficial;
4. Las credenciales se guardan, `im/channel` cambia y la extensión reinicia la conexión;
5. Envíe un mensaje al bot en esa IM.

Notas: solo un canal está activo; vuelva a escanear para regresar. El primer arranque del sidecar tarda 5–10 s y el panel espera automáticamente.

## Configuración

| Ajuste | Predeterminado | Descripción |
|---|---|---|
| `codeartsQqbot.enabled` | `false` | Iniciar el sidecar con el IDE |
| `codeartsQqbot.provider` | `inferhub-provider` | Proveedor del modelo |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | ID del modelo; no lo deje vacío |
| `codeartsQqbot.agent` | `build` | Nombre del agente |
| `codeartsQqbot.access.c2cMode` | `open` | Modo de acceso directo |
| `codeartsQqbot.access.groupMode` | `allowlist` | Modo de acceso en grupos (recomendado) |
| `codeartsQqbot.textChunkLimit` | `4500` | Máximo de caracteres por mensaje (prevalece el canal) |
| `codeartsQqbot.media.maxMB` | `200` | Límite de medios entrantes |
| `codeartsQqbot.sendFile.restrict` | `true` | Restringir rutas de archivos salientes |

## Comandos

`/new`, `/compact`, `/model`, `/stop`, `/allow`, `/deny`, `/bot-status`, `/bot-ping`, `/bot-help`.

## Seguridad y datos

- AppSecret / token de WeChat / secreto de WeCom solo en el almacén seguro o en memoria;
- La contraseña del núcleo se descifra en modo solo lectura desde el almacén oficial, con respaldo manual;
- Los archivos salientes se validan con lista blanca del espacio de trabajo (`realpath`), 20 MB por archivo;
- Los registros y diagnósticos enmascaran secretos, tokens y openids (`[REDACTED]`);
- Solo se entrega la respuesta final; detalles en [PRIVACY.md](PRIVACY.md).

## Diagnóstico

- Registro: `<globalStorage>/codearts-community.codearts-qqbot-cn/qqbot/logs/sidecar.log` (4 MB × 5)
- Exportación: «QQ Bot: 导出诊断包» incluye estado, tubería IPC, configuración, últimas 300 líneas y la matriz de compatibilidad
- Panel de salida: `CodeArts QQ Bot`

## Compilación

    npm install
    npm run check            # capas / tipos / pruebas (212)
    npm run build:sidecar    # binario único Node SEA
    npm run package:vsix     # generar el VSIX

## Componentes de código abierto

| Componente | Versión | Uso | Licencia |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | Vinculación QR de QQ y WebSocket | **UNLICENSED** (Tencent) |
| `@wecom/aibot-node-sdk` | 1.0.7 | WebSocket / streaming / medios de WeCom | condiciones del paquete |
| `qrcode` | 1.5.4 | Render de QR | MIT |
| `esbuild` | 0.24.x | Empaquetado | MIT |
| `TypeScript` | 5.x | Tipos y compilación | Apache-2.0 |
| `Vitest` | 2.1.x | Pruebas unitarias | MIT |
| `tsx` | 4.23.x | Ejecutar TypeScript | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | Referencia de protocolo WeChat/WeCom | MIT |
| CodeArts Agent / Kernel | 26.11.x / 126.11.x | Host y núcleo | términos de Huawei Cloud |

> **Aviso de distribución**: `@tencent-connect/qqbot-connector` está marcado UNLICENSED. Confirme los términos de Tencent antes de distribuir. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## Limitaciones conocidas

- Solo artefactos Windows x64;
- Dependencia estricta de las versiones de CodeArts Agent y del núcleo;
- QQ: ventana de respuesta pasiva de unos 5 minutos y máximo 5 respuestas por mensaje;
- WeChat iLink: solo mensajes directos; `ret=-14` requiere volver a escanear;
- WeCom: tarjetas con botones no implementadas; se usa interacción de texto;
- Los grupos usan allowlist por defecto;
- El envío automático de archivos está limitado por la plataforma.

## Contribuir

Se aceptan Issues y Pull Requests. `npm run check` debe pasar, la lógica nueva debe incluir pruebas y el mensaje de commit debe explicar el «por qué».

## Documentación

[PRIVACY.md](PRIVACY.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [TODO.md](TODO.md) · [docs/](docs/)

## Licencia

MIT License, `Copyright (c) 2026 ThinkTom`. Texto completo en [LICENSE](LICENSE).