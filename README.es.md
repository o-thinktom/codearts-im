# CodeArts IM

[简体中文](README.md) | [English](README.en.md) | [Русский](README.ru.md) | [فارسی](README.fa.md) | [Türkçe](README.tr.md) | **Español**

Una pasarela de mensajería que controla el **Huawei Cloud CodeArts Agent** local a través de QQ (WeChat / WeCom en la hoja de ruta). Envía un mensaje desde el móvil y el Agent del IDE de escritorio ejecutará la tarea y devolverá el resultado.

## Características

- **Vinculación por QR**: crea/vincula un bot con el conector oficial de Tencent, sin escribir AppID/AppSecret manualmente
- **Dos modos de chat**: mensajes directos y menciones en grupos (se requiere @ por defecto)
- **Gestión de sesiones**: una sesión del kernel por interlocutor, mapeo persistente y reanudación automática tras reiniciar el IDE
- **Entrega fiable**: deltas en streaming, fusión de respuestas multipaso, división compatible con Markdown, límite `msg_seq` con degradación
- **Participación humana**: aprobaciones (`1` / `2`) y preguntas (`A/B/C`)
- **Solo la respuesta final**: la cadena de pensamiento y los avisos del sistema se filtran
- **Medios**: descarga y descifrado de imágenes/archivos entrantes, envío de archivos con degradación a ruta de texto
- **Control de acceso**: open / allowlist / disabled, códigos de emparejamiento, revocación, bloqueo de instancia única
- **Verificable**: matriz de compatibilidad del kernel con `npm run compat` para regresión tras actualizar

## Arquitectura

    QQ Open Platform (WebSocket)
      ↕
    sidecar (binario único Node SEA)
      ↕ IPC local (tubería con nombre + token de un solo uso)
    Extensión de VS Code (VSIX)
      ↕ HTTP local + SSE
    CodeArts Agent Kernel (Session / Tools / Permission / Skills)

- Las credenciales y el kernel permanecen en la máquina local; el sidecar no abre puertos públicos;
- `KernelPort` es la única frontera con el kernel; el transporte de QQ vive en `adapters/qq`;
- La extensión gestiona el ciclo de vida, la vinculación por QR, el descubrimiento del puerto del kernel y el descifrado del secreto.

## Compatibilidad

| Elemento | Soporte | Nota |
|---|---|---|
| Sistema operativo | Windows 10 1809+ / Windows 11 (x64) | El artefacto publicado es win32-x64; macOS/Linux deben compilarse en su plataforma |
| CodeArts Agent | ≥ 26.11.100 | Verificado en 26.11.x |
| Agent Kernel | 126.11.x | Verificado en `126.11.2-20261117200150` |
| VS Code API | `^1.109.0` | Solo API estables |
| QQ Open Platform | Bot WebSocket API v2 | Bot de sandbox o producción |
| Node.js (solo desarrollo) | ≥ 20.3 | El usuario final no lo necesita; el sidecar incluye su runtime |

Comprobaciones de compatibilidad:

    npm run compat                    # solo lectura + crear/eliminar sesión
    npm run compat -- --with-prompt   # añade una inferencia real (consumo mínimo de cuota)

## Versión

- Versión actual: **0.3.2** (versionado semántico; en 0.x las interfaces pueden cambiar)
- Base de compatibilidad: CodeArts Agent 26.11.100 / Kernel 126.11.2
- Política de actualización: tras actualizar el IDE o el kernel, ejecute primero la matriz de compatibilidad
- Historial de cambios: commits del repositorio y documentos de diseño en `output/`

## Instalación

Requisitos: Windows x64, CodeArts Agent 26.11.x. **No** se requiere Node.js.

    & "<directorio de CodeArts>\bin\codearts-agent.cmd" --install-extension "<ruta>\codearts-qqbot-cn-0.3.2.vsix"

También puede usar «Install from VSIX» en la vista de extensiones y luego «Developer: Reload Window».

## Inicio rápido

1. Inicie CodeArts Agent y complete una conversación para que el kernel esté activo;
2. Paleta de comandos → «QQ Bot: 扫码绑定机器人» (vincular por QR);
3. Escanee el QR oficial con QQ móvil y complete la creación/vinculación en la página de Tencent;
4. Las credenciales se guardan en el almacén seguro del sistema y la conexión se reinicia automáticamente;
5. Envíe un mensaje directo al bot.

Si el escaneo no está disponible, use «QQ Bot: 手动填写凭据» (entrada manual).

## Configuración

| Ajuste | Valor por defecto | Descripción |
|---|---|---|
| `codeartsQqbot.provider` | `inferhub-provider` | Proveedor de modelo |
| `codeartsQqbot.model` | `deepseek-v4.1-flash-1017` | ID del modelo — no lo deje vacío |
| `codeartsQqbot.agent` | `build` | Agent a utilizar |
| `codeartsQqbot.access.c2cMode` | `open` | Modo de acceso para mensajes directos |
| `codeartsQqbot.access.groupMode` | `allowlist` | Modo de acceso para grupos (mantener en producción) |
| `codeartsQqbot.textChunkLimit` | `4500` | Máximo de caracteres por mensaje |
| `codeartsQqbot.media.maxMB` | `200` | Límite de tamaño de medios entrantes |
| `codeartsQqbot.sendFile.restrict` | `true` | Restringir rutas de archivos salientes |

## Comandos

| Comando | Propósito |
|---|---|
| `/new` | Nueva sesión |
| `/compact` | Compactar contexto |
| `/model` | Ver / cambiar modelo |
| `/stop` | Abortar el turno actual |
| `/allow`, `/deny` | Aprobar / rechazar una solicitud |
| `/bot-status`, `/bot-ping`, `/bot-help` | Estado, latencia, ayuda |

## Seguridad y datos

- AppSecret y la contraseña del kernel solo residen en el almacén seguro del sistema o en memoria — nunca en configuración, repositorio o registros;
- La contraseña del kernel se lee del almacén cifrado oficial mediante descifrado de solo lectura, con entrada manual como respaldo;
- Los archivos salientes se validan con listas `realpath` (workspace + medios), 20 MB por archivo;
- Los registros y diagnósticos enmascaran secretos, tokens y openid;
- Solo se entrega la respuesta final; el razonamiento y los avisos del sistema nunca llegan a QQ.

## Compilación

Entorno de desarrollo: Windows x64, Node.js ≥ 20.3, CodeArts Agent 26.11.x para la integración.

    npm install
    npm run check            # reglas de capas / tipos / pruebas unitarias
    npm run build:sidecar    # ejecutable único Node SEA
    npm run package:vsix     # compilar la extensión y empaquetar el VSIX

## Componentes de código abierto y agradecimientos

| Componente | Versión | Uso | Licencia |
|---|---|---|---|
| `@tencent-connect/qqbot-connector` | 1.2.0 | Vinculación QR y conexión WebSocket de QQ | **UNLICENSED** (propietario de Tencent; sujeto a sus términos) |
| `qrcode` | 1.5.4 | Renderizado de QR | MIT |
| `esbuild` | 0.24.x | Empaquetado | MIT |
| `TypeScript` | 5.x | Sistema de tipos y compilación | Apache-2.0 |
| `Vitest` | 2.1.x | Pruebas unitarias | MIT |
| `tsx` | 4.23.x | Ejecutar TypeScript en desarrollo | MIT |
| `@xmanrui/dsh-im` | 5.10.0 | Referencia de protocolo WeChat/WeCom (no es dependencia directa) | MIT |
| CodeArts Agent / Agent Kernel | 26.11.x / 126.11.x | Host y kernel | Términos del producto Huawei Cloud |

Agradecimientos: Tencent QQ Open Platform y la comunidad DeepSeek Harness (`dsh-qqbot`, `dsh-im`) por sus prácticas públicas de protocolo e interacción.

> **Nota de distribución**: `@tencent-connect/qqbot-connector` está marcado como UNLICENSED. Confirme los términos de licencia de Tencent antes de distribuir artefactos VSIX/sidecar empaquetados.

## Limitaciones conocidas

- Solo artefactos Windows x64; otras plataformas requieren compilación nativa;
- Fuertemente acoplado a las versiones de CodeArts Agent/kernel — se requiere regresión tras actualizar;
- La ventana de respuesta pasiva de QQ es de unos 5 minutos y como máximo 5 respuestas por mensaje;
- Los grupos usan allowlist por defecto; `open` es solo para integración local;
- Las aprobaciones y preguntas son de texto (dígitos/letras); las tarjetas con botones aún no están implementadas.

## Solución de problemas

Abra el canal de salida «CodeArts QQ Bot» y revise los marcadores del registro:

| Registro | Significado |
|---|---|
| `sidecar binary not found` | El VSIX no incluye `bin/`; reinstale |
| `ipc bridge connected` | Extensión y sidecar conectados |
| `已从码道加密存储获取内核口令` | Contraseña del kernel obtenida automáticamente |
| `sidecar running` / `qq bot ready` | Servicio y conexión de QQ listos |
| `qq message received` | Mensaje entrante de QQ recibido |
| `inbound accepted` / `kernel prompt sending` | Enviado al kernel |
| `reply sending` / `outbound send failed` | Resultado del envío y motivo del fallo |

## Contribuciones

Se aceptan Issues y Pull Requests. Asegúrese de que `npm run check` pase, añada pruebas para la nueva lógica y explique el **porqué** en el mensaje de commit.

## Licencia

El código del proyecto se distribuye bajo **MIT License**. Los componentes de terceros conservan sus licencias; `@tencent-connect/qqbot-connector` es UNLICENSED — verifique la autorización antes de redistribuir.