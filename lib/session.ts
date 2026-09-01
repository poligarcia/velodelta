export const VELODELTA_SESSION_FORMAT = 'velodelta-session';
export const VELODELTA_SESSION_VERSION = 1;

const MAX_SESSION_POINTS = 250_000;

export type ChartMetric = 'speed' | 'acceleration';
export type FloatingMetric = 'speed' | 'acceleration' | 'time' | 'distance';

export type SessionSettings = {
  chart: ChartMetric[];
  floating: FloatingMetric[];
};

export type SessionPoint = {
  timestampMs: number;
  elapsedSeconds: number;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  reportedSpeedMps: number | null;
  speedKmh: number;
  accelerationMps2: number | null;
  distanceMeters: number;
  segment: number;
};

export type SessionGap = {
  startSeconds: number;
  endSeconds: number;
};

export type SessionSnapshot = {
  startedAtMs: number;
  endedAtMs: number;
  finalState: {
    elapsedSeconds: number;
    distanceMeters: number;
    speedKmh: number;
    accelerationMps2: number;
  };
  points: SessionPoint[];
  gaps: SessionGap[];
  settings: SessionSettings;
};

export type VeloDeltaSessionFile = {
  format: typeof VELODELTA_SESSION_FORMAT;
  version: typeof VELODELTA_SESSION_VERSION;
  exportedAt: string;
  session: {
    startedAt: string;
    endedAt: string;
    finalState: SessionSnapshot['finalState'];
    points: SessionPoint[];
    gaps: SessionGap[];
    settings: SessionSettings;
  };
};

export class InvalidSessionFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSessionFileError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string) {
  if (!isRecord(value)) throw new InvalidSessionFileError(`${label} no es un objeto válido.`);
  return value;
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new InvalidSessionFileError(`${label} no es una lista válida.`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidSessionFileError(`${label} no es un número válido.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string) {
  const number = requireFiniteNumber(value, label);
  if (number < 0) throw new InvalidSessionFileError(`${label} no puede ser negativo.`);
  return number;
}

function requireNullableNumber(value: unknown, label: string) {
  return value === null ? null : requireFiniteNumber(value, label);
}

function requireDate(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new InvalidSessionFileError(`${label} no es una fecha válida.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new InvalidSessionFileError(`${label} no es una fecha válida.`);
  }
  return timestamp;
}

function parseSettings(value: unknown): SessionSettings {
  const settings = requireRecord(value, 'La configuración');
  const chart = requireArray(settings.chart, 'La configuración del gráfico');
  const floating = requireArray(settings.floating, 'La configuración flotante');
  const validChart = new Set<ChartMetric>(['speed', 'acceleration']);
  const validFloating = new Set<FloatingMetric>([
    'speed',
    'acceleration',
    'time',
    'distance',
  ]);

  if (!chart.every((metric): metric is ChartMetric => validChart.has(metric as ChartMetric))) {
    throw new InvalidSessionFileError('La configuración del gráfico contiene una métrica desconocida.');
  }
  if (
    !floating.every((metric): metric is FloatingMetric =>
      validFloating.has(metric as FloatingMetric),
    )
  ) {
    throw new InvalidSessionFileError('La configuración flotante contiene una métrica desconocida.');
  }
  if (new Set(chart).size !== chart.length || new Set(floating).size !== floating.length) {
    throw new InvalidSessionFileError('La configuración contiene métricas repetidas.');
  }

  return { chart: [...chart], floating: [...floating] };
}

function parsePoint(value: unknown, index: number): SessionPoint {
  const point = requireRecord(value, `El punto ${index + 1}`);
  const latitude = requireFiniteNumber(point.latitude, `La latitud del punto ${index + 1}`);
  const longitude = requireFiniteNumber(point.longitude, `La longitud del punto ${index + 1}`);
  const segment = requireNonNegativeNumber(point.segment, `El segmento del punto ${index + 1}`);

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new InvalidSessionFileError(`El punto ${index + 1} tiene coordenadas fuera de rango.`);
  }
  if (!Number.isInteger(segment)) {
    throw new InvalidSessionFileError(`El segmento del punto ${index + 1} no es válido.`);
  }

  return {
    timestampMs: requireNonNegativeNumber(
      point.timestampMs,
      `La fecha del punto ${index + 1}`,
    ),
    elapsedSeconds: requireNonNegativeNumber(
      point.elapsedSeconds,
      `El tiempo del punto ${index + 1}`,
    ),
    latitude,
    longitude,
    accuracyMeters: requireNonNegativeNumber(
      point.accuracyMeters,
      `La precisión del punto ${index + 1}`,
    ),
    reportedSpeedMps: requireNullableNumber(
      point.reportedSpeedMps,
      `La velocidad GPS del punto ${index + 1}`,
    ),
    speedKmh: requireNonNegativeNumber(point.speedKmh, `La velocidad del punto ${index + 1}`),
    accelerationMps2: requireNullableNumber(
      point.accelerationMps2,
      `La aceleración del punto ${index + 1}`,
    ),
    distanceMeters: requireNonNegativeNumber(
      point.distanceMeters,
      `La distancia del punto ${index + 1}`,
    ),
    segment,
  };
}

function parseGap(value: unknown, index: number): SessionGap {
  const gap = requireRecord(value, `El intervalo ${index + 1}`);
  const startSeconds = requireNonNegativeNumber(
    gap.startSeconds,
    `El inicio del intervalo ${index + 1}`,
  );
  const endSeconds = requireNonNegativeNumber(
    gap.endSeconds,
    `El fin del intervalo ${index + 1}`,
  );
  if (endSeconds < startSeconds) {
    throw new InvalidSessionFileError(`El intervalo ${index + 1} termina antes de empezar.`);
  }
  return { startSeconds, endSeconds };
}

export function createSessionFile(
  snapshot: SessionSnapshot,
  exportedAtMs = Date.now(),
): VeloDeltaSessionFile {
  return {
    format: VELODELTA_SESSION_FORMAT,
    version: VELODELTA_SESSION_VERSION,
    exportedAt: new Date(exportedAtMs).toISOString(),
    session: {
      startedAt: new Date(snapshot.startedAtMs).toISOString(),
      endedAt: new Date(snapshot.endedAtMs).toISOString(),
      finalState: { ...snapshot.finalState },
      points: snapshot.points.map((point) => ({ ...point })),
      gaps: snapshot.gaps.map((gap) => ({ ...gap })),
      settings: {
        chart: [...snapshot.settings.chart],
        floating: [...snapshot.settings.floating],
      },
    },
  };
}

export function serializeSession(snapshot: SessionSnapshot, exportedAtMs = Date.now()) {
  return `${JSON.stringify(createSessionFile(snapshot, exportedAtMs), null, 2)}\n`;
}

export function parseSession(value: unknown): SessionSnapshot {
  const file = requireRecord(value, 'El archivo');
  if (file.format !== VELODELTA_SESSION_FORMAT) {
    throw new InvalidSessionFileError('El archivo no es una sesión de VeloDelta.');
  }
  if (file.version !== VELODELTA_SESSION_VERSION) {
    throw new InvalidSessionFileError('La versión del archivo no es compatible con esta app.');
  }

  requireDate(file.exportedAt, 'La fecha de exportación');
  const session = requireRecord(file.session, 'La sesión');
  const startedAtMs = requireDate(session.startedAt, 'La fecha de inicio');
  const endedAtMs = requireDate(session.endedAt, 'La fecha de finalización');
  if (endedAtMs < startedAtMs) {
    throw new InvalidSessionFileError('La sesión termina antes de empezar.');
  }

  const state = requireRecord(session.finalState, 'El estado final');
  const pointsInput = requireArray(session.points, 'Los puntos');
  if (pointsInput.length > MAX_SESSION_POINTS) {
    throw new InvalidSessionFileError('La sesión contiene demasiados puntos para cargarla.');
  }

  const points = pointsInput.map(parsePoint);
  for (let index = 1; index < points.length; index += 1) {
    if (
      points[index].elapsedSeconds < points[index - 1].elapsedSeconds ||
      points[index].timestampMs < points[index - 1].timestampMs
    ) {
      throw new InvalidSessionFileError('Los puntos no están ordenados cronológicamente.');
    }
  }

  const gaps = requireArray(session.gaps, 'Los intervalos').map(parseGap);
  for (let index = 1; index < gaps.length; index += 1) {
    if (gaps[index].startSeconds < gaps[index - 1].startSeconds) {
      throw new InvalidSessionFileError('Los intervalos no están ordenados cronológicamente.');
    }
  }

  return {
    startedAtMs,
    endedAtMs,
    finalState: {
      elapsedSeconds: requireNonNegativeNumber(
        state.elapsedSeconds,
        'El tiempo final',
      ),
      distanceMeters: requireNonNegativeNumber(
        state.distanceMeters,
        'La distancia final',
      ),
      speedKmh: requireNonNegativeNumber(state.speedKmh, 'La velocidad final'),
      accelerationMps2: requireFiniteNumber(
        state.accelerationMps2,
        'La aceleración final',
      ),
    },
    points,
    gaps,
    settings: parseSettings(session.settings),
  };
}

export function parseSessionJson(json: string) {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidSessionFileError('El archivo no contiene JSON válido.');
  }
  return parseSession(value);
}
