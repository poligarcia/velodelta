# VeloDelta

Aplicación web mobile-first para medir velocidad, aceleración, distancia y tiempo con el GPS del navegador. Está optimizada para Safari en iPhone, funciona como aplicación web instalable y no utiliza backend.

VeloDelta nació de una pregunta concreta: cómo explicar visualmente el concepto de derivada a partir del movimiento. El proyecto comienza como un velocímetro GPS y está pensado para evolucionar hacia la relación entre velocidad, aceleración, pendiente y el límite de `Δv / Δt` cuando `Δt` tiende a cero.

La versión pública se encuentra en [poligarcia.github.io/velodelta](https://poligarcia.github.io/velodelta/).

## Funcionalidad

- Seguimiento continuo mediante `navigator.geolocation.watchPosition` con alta precisión.
- Velocidad nativa del GPS con cálculo por distancia como alternativa.
- Distancia acumulada con filtrado de precisión y movimientos improbables.
- Aceleración, tiempo transcurrido y gráfico interactivo.
- Detección visual de intervalos sin datos al cambiar de aplicación.
- Bloqueo de pantalla activa cuando el navegador lo admite.
- Preferencias locales para las series del gráfico y las métricas flotantes.
- Manifest e iconos para instalar la aplicación en la pantalla de inicio.

## Requisitos

- Node.js 22.13 o posterior.
- npm 10 o posterior.
- HTTPS o `localhost` para utilizar la API de geolocalización.

## Desarrollo local

```bash
npm ci
npm run dev
```

La aplicación queda disponible en `http://localhost:5173`.

Para validar el flujo sin compartir una ubicación real, el modo de desarrollo incluye una señal GPS sintética:

```text
http://localhost:5173/?simulateGps=1&simulateGap=1
```

La simulación sólo se habilita durante el desarrollo local.

## Validación

```bash
npm test
npm run lint
npm run build
```

Para previsualizar el resultado de producción localmente:

```bash
npm run preview
```

## Estructura

- `app/page.tsx`: seguimiento GPS, estado de la sesión, gráfico y controles.
- `app/globals.css`: sistema visual y comportamiento responsive.
- `index.html`: documento principal, metadata, PWA y social preview.
- `main.tsx`: entrada de React.
- `lib/tracking.ts`: cálculos y formateo reutilizables, cubiertos por tests.
- `tests/`: tests unitarios con el runner incluido en Node.js.
- `public/`: manifest, iconos y tarjeta social.
- `vite.config.ts`: configuración del build estático con Vite.
- `.github/workflows/pages.yml`: validación y publicación en GitHub Pages.

## Privacidad

La aplicación no tiene backend y no envía posiciones a un servidor propio. Las lecturas GPS se mantienen en memoria durante la sesión y las preferencias de interfaz se guardan únicamente en `localStorage` del dispositivo.

## Publicación

Cada push a `main` ejecuta tests, lint y build antes de publicar el resultado estático mediante GitHub Pages. Una compilación local no publica cambios automáticamente.

## Licencia

Distribuido bajo la licencia MIT. Consultá [LICENSE](LICENSE).
