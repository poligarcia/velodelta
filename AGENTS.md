# AGENTS.md

Estas instrucciones aplican a todo el repositorio. Cualquier agente que trabaje aquí debe leer este archivo completo antes de inspeccionar, modificar, ejecutar, commitear, compartir o publicar contenido del proyecto.

## Contexto del producto

`VeloDelta` es una aplicación web mobile-first que mide velocidad, aceleración, distancia y tiempo mediante el GPS del navegador. Nació para explorar visualmente la derivada a partir del movimiento y está pensada para incorporar la relación entre velocidad, aceleración, pendiente y el límite de `Δv / Δt`.

- Está optimizada principalmente para Safari en iPhone y se puede instalar en la pantalla de inicio.
- Usa `navigator.geolocation.watchPosition` con alta precisión.
- Incluye métricas, gráfico interactivo, detección de intervalos sin GPS, Wake Lock y preferencias locales.
- No tiene backend. Las posiciones se mantienen en memoria y las preferencias se guardan en `localStorage`.
- No se deben agregar analytics, telemetría, almacenamiento remoto, autenticación ni transmisión de ubicaciones sin autorización explícita y una revisión de privacidad.
- La simulación GPS de desarrollo debe usar coordenadas sintéticas neutrales. Nunca usar rutas, domicilios ni ubicaciones reales de una persona.

## Stack y estructura

- Node.js 22 o posterior y npm con `package-lock.json`.
- React 19, Vite y Tailwind CSS.
- `app/page.tsx`: experiencia principal, GPS, métricas, gráfico y controles.
- `app/globals.css`: estilos y comportamiento responsive.
- `index.html`: documento principal, metadata, PWA y social preview.
- `main.tsx`: entrada de React.
- `lib/tracking.ts`: cálculos reutilizables.
- `tests/`: tests unitarios con el runner de Node.js.
- `public/`: manifest, iconos y tarjeta social.
- `.github/workflows/pages.yml`: validación y publicación en GitHub Pages.

Comandos principales:

```bash
npm ci
npm run dev
npm test
npm run lint
npm run build
npm audit --audit-level=moderate
```

## Reglas de trabajo

- Preservar los cambios existentes del usuario y evitar reescrituras fuera del alcance solicitado.
- Usar el lockfile existente. No cambiar de package manager.
- Mantener el diseño, el idioma español rioplatense y la experiencia mobile-first salvo pedido explícito.
- Probar cualquier cambio de interfaz en un viewport similar a iPhone, vertical y horizontal, y revisar la consola.
- Mantener `Pablo García` como autor y `1264073+poligarcia@users.noreply.github.com` como email Git local. Nunca volver a introducir el Gmail personal en commits, archivos o documentación.
- No hacer commit, push, force-push, publicación, deploy, cambio de acceso ni comunicación externa salvo que la solicitud del usuario lo autorice explícitamente en el turno actual.
- No ejecutar una publicación como consecuencia implícita de un cambio de código. Publicar es una acción separada.

## Publicación

El destino público es GitHub Pages:

- Repositorio: `poligarcia/velodelta`.
- URL: `https://poligarcia.github.io/velodelta/`.
- La rama pública es `main` y el workflow debe publicar únicamente después de que tests, lint y build pasen.
- La publicación histórica de OpenAI Sites está retirada. No restaurarla ni crear otro sitio sin autorización explícita.
- No guardar credenciales de GitHub, tokens de Actions ni URLs autenticadas en archivos, Git config, remotes, logs o mensajes.
- No desplegar como consecuencia implícita de un cambio local; cada publicación requiere autorización explícita.

## Gate de seguridad obligatorio

**Todo cambio, sin excepción —incluidos documentación, configuración, dependencias, assets, tests y refactors— debe pasar este gate antes de considerarse terminado.** El gate es bloqueante y funciona con criterio `fail closed`: si una comprobación no puede completarse o existe duda, el resultado es `FAIL` y el agente debe detener cualquier commit, push, publicación, deploy o entrega externa.

### 1. Alcance y diff

- Revisar `git status --short`, `git diff` y, si hay staging, `git diff --cached`.
- Confirmar que sólo haya archivos y cambios necesarios para la solicitud.
- Ejecutar `git diff --check` y `git diff --cached --check` cuando corresponda.
- Verificar que artefactos generados, caches, logs, capturas temporales y archivos locales no estén incluidos.

### 2. Información sensible

Escanear archivos modificados, archivos nuevos, contenido trackeado y cualquier historial que vaya a publicarse. Revisar también metadata de imágenes y otros binarios.

Bloquear ante cualquiera de estos elementos:

- API keys, tokens, secretos OAuth, cookies, sesiones, credenciales, contraseñas o códigos de recuperación.
- Claves privadas, certificados, archivos `.env`, `.npmrc`, credenciales cloud o URLs con autenticación embebida.
- Emails personales, teléfonos, domicilios, documentos, identificadores privados o información financiera.
- Coordenadas GPS precisas, rutas reales, historiales de ubicación o metadata EXIF sensible.
- URLs privadas, nombres internos, logs, dumps, prompts o salidas de terminal que contengan datos del usuario.
- Datos copiados desde conectores, navegador, servicios externos o sistemas locales que no sean imprescindibles y públicos.

Valores públicos intencionales permitidos:

- La URL pública del producto.
- El nombre `Pablo García` y el email GitHub noreply indicado arriba.
- Coordenadas sintéticas neutrales usadas únicamente por la simulación local.

Los escaneos no deben imprimir el valor completo de un posible secreto. Reportar sólo tipo, archivo, línea y una versión redactada. Si se encuentra un secreto, no commitearlo ni compartirlo; retirarlo, avisar al usuario y, si pudo salir del equipo, recomendar su rotación. Cualquier limpieza destructiva del historial requiere autorización explícita.

### 3. Dependencias y código

- Ejecutar `npm audit --audit-level=moderate`; debe terminar con cero vulnerabilidades sin usar `--force` ni ignorar peers.
- Ejecutar `npm test`; todos los tests deben pasar.
- Ejecutar `npm run lint`; no aceptar errores ni advertencias nuevas sin justificación.
- Ejecutar `npm run build`; el build debe finalizar correctamente.
- No ocultar fallos desactivando reglas, borrando tests o suprimiendo avisos sin investigar la causa.

### 4. Validación de comportamiento

Si se modificó código ejecutable, estilos, assets o dependencias de runtime:

- Iniciar el servidor local y confirmar una respuesta HTTP exitosa.
- Revisar errores y advertencias JavaScript en una sesión limpia.
- Validar vertical y landscape en viewport tipo iPhone.
- Para GPS usar sólo el modo sintético de desarrollo; no aceptar permisos ni capturar ubicación real durante pruebas automatizadas.

Los cambios exclusivamente documentales pueden omitir la validación visual, pero no las revisiones de diff, secretos, tests, lint, build y dependencias.

### 5. Gate adicional antes de publicar

Inmediatamente antes de cualquier push a un repositorio público, publicación o deploy:

- Repetir completo el escaneo de información sensible sobre el commit exacto que se va a publicar y su historial alcanzable.
- Confirmar que el autor use el email noreply.
- Confirmar que el workflow apunta al repositorio y entorno GitHub Pages autorizados y que no existe configuración heredada de otro proveedor.
- Confirmar que la URL, el nivel de acceso y el destino son exactamente los autorizados por el usuario.
- Requerir una instrucción explícita de publicación en el turno actual. Una aprobación antigua o genérica no alcanza.

## Resultado obligatorio del gate

Al terminar una tarea, el agente debe informar uno de estos estados:

- `SECURITY GATE: PASS` — todas las comprobaciones aplicables pasaron y no se detectó información sensible.
- `SECURITY GATE: FAIL` — indicar el bloqueo de forma redactada y no publicar, desplegar, pushear ni compartir el cambio.

Un resultado `PASS` habilita la entrega local, pero nunca reemplaza la autorización explícita necesaria para publicar o desplegar.
