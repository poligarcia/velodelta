import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import {
  clamp,
  formatDistance,
  formatTime,
  haversineMeters,
  type Reading,
} from '../lib/tracking';

type Sample = {
  time: number;
  speed: number;
  acceleration: number | null;
  segment: number;
};

type Gap = { start: number; end: number };
type ChartRange = { start: number; end: number };
type ChartMetric = 'speed' | 'acceleration';
type FloatingMetric = 'speed' | 'acceleration' | 'time' | 'distance';

type MetricSettings = {
  chart: ChartMetric[];
  floating: FloatingMetric[];
};

const MAX_PLAUSIBLE_SPEED_MPS = 25;
const MAX_PLAUSIBLE_ACCELERATION_MPS2 = 12;
const MAX_ACCEPTABLE_ACCURACY_METERS = 80;
const SETTINGS_STORAGE_KEY = 'velocimetro-settings-v1';
const DEFAULT_SETTINGS: MetricSettings = {
  chart: ['speed'],
  floating: ['speed'],
};

const CHART_METRICS: Array<{ id: ChartMetric; label: string; detail: string }> = [
  { id: 'speed', label: 'Velocidad', detail: 'km/h' },
  { id: 'acceleration', label: 'Aceleración', detail: 'm/s²' },
];

const FLOATING_METRICS: Array<{
  id: FloatingMetric;
  label: string;
  detail: string;
}> = [
  { id: 'speed', label: 'Velocidad', detail: 'km/h' },
  { id: 'acceleration', label: 'Aceleración', detail: 'm/s²' },
  { id: 'time', label: 'Tiempo', detail: 'duración' },
  { id: 'distance', label: 'Distancia', detail: 'm o km' },
];

type ScreenWakeLockSentinel = EventTarget & {
  readonly released: boolean;
  release: () => Promise<void>;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<ScreenWakeLockSentinel>;
  };
};

type PositionLike = Pick<GeolocationPosition, 'timestamp'> & {
  coords: Pick<GeolocationCoordinates, 'latitude' | 'longitude' | 'accuracy' | 'speed'>;
};

function readStoredSettings(): MetricSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
    if (!stored || typeof stored !== 'object') return DEFAULT_SETTINGS;

    const validChartMetrics = new Set<ChartMetric>(['speed', 'acceleration']);
    const validFloatingMetrics = new Set<FloatingMetric>([
      'speed',
      'acceleration',
      'time',
      'distance',
    ]);
    const chartValues: unknown[] = Array.isArray(stored.chart) ? stored.chart : [];
    const floatingValues: unknown[] = Array.isArray(stored.floating) ? stored.floating : [];
    const chart: ChartMetric[] = Array.isArray(stored.chart)
      ? [...new Set(chartValues.filter((metric): metric is ChartMetric =>
          validChartMetrics.has(metric as ChartMetric),
        ))]
      : DEFAULT_SETTINGS.chart;
    const floating: FloatingMetric[] = Array.isArray(stored.floating)
      ? [...new Set(floatingValues.filter((metric): metric is FloatingMetric =>
          validFloatingMetrics.has(metric as FloatingMetric),
        ))]
      : DEFAULT_SETTINGS.floating;

    return { chart, floating };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function SpeedChart({
  samples,
  gaps,
  elapsed,
  showSpeed,
  showAcceleration,
}: {
  samples: Sample[];
  gaps: Gap[];
  elapsed: number;
  showSpeed: boolean;
  showAcceleration: boolean;
}) {
  const chartContainer = useRef<HTMLDivElement | null>(null);
  const [width, setChartWidth] = useState(720);
  const height = 310;
  const compact = width < 480;
  const padding = useMemo(
    () => ({
      top: 22,
      right: compact ? 43 : 54,
      bottom: 44,
      left: compact ? 42 : 50,
    }),
    [compact],
  );
  const [range, setRange] = useState<ChartRange | null>(null);
  const [selectedSample, setSelectedSample] = useState<Sample | null>(null);
  const gesture = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    startRange: null as ChartRange | null,
    startDistance: 0,
    startMidpoint: 0,
    startX: 0,
    moved: false,
  });
  const hasChartMetrics = showSpeed || showAcceleration;
  const chartDescription = showSpeed
    ? showAcceleration
      ? 'velocidad y aceleración'
      : 'velocidad'
    : showAcceleration
      ? 'aceleración'
      : 'ninguna métrica';

  useEffect(() => {
    const container = chartContainer.current;
    if (!container) return;

    const updateWidth = () => {
      setChartWidth(Math.round(clamp(container.clientWidth, 300, 720)));
    };
    updateWidth();

    const ResizeObserverConstructor = window.ResizeObserver as
      | typeof ResizeObserver
      | undefined;
    if (!ResizeObserverConstructor) {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserverConstructor(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const domainMax = Math.max(
    30,
    elapsed,
    samples.at(-1)?.time ?? 0,
    gaps.at(-1)?.end ?? 0,
  );

  const activeRange = useMemo(() => {
    if (!range) return { start: 0, end: domainMax };
    const span = Math.min(domainMax, Math.max(5, range.end - range.start));
    const start = clamp(range.start, 0, Math.max(0, domainMax - span));
    return { start, end: start + span };
  }, [domainMax, range]);

  const geometry = useMemo(() => {
    const observedMax = Math.max(0, ...samples.map((sample) => sample.speed));
    const maxSpeed = Math.max(20, Math.ceil(observedMax / 10) * 10);
    const observedAcceleration = Math.max(
      0,
      ...samples.map((sample) => Math.abs(sample.acceleration ?? 0)),
    );
    const maxAcceleration = Math.max(1, Math.ceil(observedAcceleration * 2) / 2);
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const visibleDuration = Math.max(1, activeRange.end - activeRange.start);
    const x = (time: number) =>
      padding.left + ((time - activeRange.start) / visibleDuration) * innerWidth;
    const y = (sampleSpeed: number) =>
      padding.top + innerHeight - (sampleSpeed / maxSpeed) * innerHeight;
    const accelerationY = (acceleration: number) =>
      padding.top +
      innerHeight / 2 -
      (acceleration / maxAcceleration) * (innerHeight / 2);

    const groups = new Map<number, Sample[]>();
    for (const sample of samples) {
      const group = groups.get(sample.segment) ?? [];
      group.push(sample);
      groups.set(sample.segment, group);
    }

    return {
      maxSpeed,
      maxAcceleration,
      groups: [...groups.values()],
      x,
      y,
      accelerationY,
    };
  }, [activeRange, padding, samples, width]);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => geometry.maxSpeed * ratio);
  const accelerationTicks = [-1, -0.5, 0, 0.5, 1].map(
    (ratio) => geometry.maxAcceleration * ratio,
  );
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(
    (ratio) => activeRange.start + (activeRange.end - activeRange.start) * ratio,
  );

  const clampRange = (nextRange: ChartRange) => {
    const span = clamp(nextRange.end - nextRange.start, 5, domainMax);
    const start = clamp(nextRange.start, 0, Math.max(0, domainMax - span));
    if (span >= domainMax * 0.995) {
      setRange(null);
    } else {
      setRange({ start, end: start + span });
    }
  };

  const svgXFromClient = (clientX: number, element: SVGSVGElement) => {
    const bounds = element.getBoundingClientRect();
    return ((clientX - bounds.left) / bounds.width) * width;
  };

  const timeFromClient = (
    clientX: number,
    element: SVGSVGElement,
    chartRange: ChartRange,
  ) => {
    const svgX = clamp(svgXFromClient(clientX, element), padding.left, width - padding.right);
    const ratio = (svgX - padding.left) / (width - padding.left - padding.right);
    return chartRange.start + ratio * (chartRange.end - chartRange.start);
  };

  const selectNearestSample = (clientX: number, element: SVGSVGElement) => {
    if (samples.length === 0) return;
    const targetTime = timeFromClient(clientX, element, activeRange);
    const visibleSamples = samples.filter(
      (sample) => sample.time >= activeRange.start && sample.time <= activeRange.end,
    );
    if (visibleSamples.length === 0) return;
    const nearest = visibleSamples.reduce((best, sample) =>
      Math.abs(sample.time - targetTime) < Math.abs(best.time - targetTime) ? sample : best,
    );
    setSelectedSample(nearest);
  };

  const beginGesture = (event: ReactPointerEvent<SVGRectElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const state = gesture.current;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    state.moved = false;

    if (state.pointers.size === 1) {
      state.startRange = activeRange;
      state.startX = event.clientX;
    } else if (state.pointers.size === 2) {
      const [first, second] = [...state.pointers.values()];
      state.startRange = activeRange;
      state.startDistance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
      state.startMidpoint = (first.x + second.x) / 2;
    }
  };

  const moveGesture = (event: ReactPointerEvent<SVGRectElement>) => {
    const state = gesture.current;
    if (!state.pointers.has(event.pointerId) || !state.startRange) return;
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (state.pointers.size >= 2) {
      const [first, second] = [...state.pointers.values()];
      const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
      const midpoint = (first.x + second.x) / 2;
      const startSpan = state.startRange.end - state.startRange.start;
      const nextSpan = clamp(startSpan * (state.startDistance / distance), 5, domainMax);
      const anchorTime = timeFromClient(state.startMidpoint, event.currentTarget.ownerSVGElement!, state.startRange);
      const midpointSvgX = clamp(
        svgXFromClient(midpoint, event.currentTarget.ownerSVGElement!),
        padding.left,
        width - padding.right,
      );
      const midpointRatio =
        (midpointSvgX - padding.left) / (width - padding.left - padding.right);
      clampRange({
        start: anchorTime - midpointRatio * nextSpan,
        end: anchorTime + (1 - midpointRatio) * nextSpan,
      });
      state.moved = true;
      return;
    }

    const movedPixels = event.clientX - state.startX;
    if (Math.abs(movedPixels) > 5) state.moved = true;
    const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const startSpan = state.startRange.end - state.startRange.start;
    const secondsPerPixel = startSpan / (bounds.width * ((width - padding.left - padding.right) / width));
    const nextStart = state.startRange.start - movedPixels * secondsPerPixel;
    clampRange({ start: nextStart, end: nextStart + startSpan });
  };

  const endGesture = (event: ReactPointerEvent<SVGRectElement>, cancelled = false) => {
    const state = gesture.current;
    const wasSinglePointer = state.pointers.size === 1;
    if (!cancelled && wasSinglePointer && !state.moved) {
      selectNearestSample(event.clientX, event.currentTarget.ownerSVGElement!);
    }
    state.pointers.delete(event.pointerId);

    if (state.pointers.size === 1) {
      const remaining = [...state.pointers.values()][0];
      state.startRange = activeRange;
      state.startX = remaining.x;
      state.moved = true;
    } else if (state.pointers.size === 0) {
      state.startRange = null;
    }
  };

  const zoomWithWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.002);
    const span = activeRange.end - activeRange.start;
    const nextSpan = clamp(span * factor, 5, domainMax);
    const anchor = timeFromClient(event.clientX, event.currentTarget, activeRange);
    const ratio = (anchor - activeRange.start) / span;
    clampRange({
      start: anchor - ratio * nextSpan,
      end: anchor + (1 - ratio) * nextSpan,
    });
  };

  const selectedVisible =
    selectedSample &&
    selectedSample.time >= activeRange.start &&
    selectedSample.time <= activeRange.end
      ? selectedSample
      : null;

  return (
    <div
      ref={chartContainer}
      className="chart-wrap"
      aria-label={`Gráfico interactivo de ${chartDescription} versus tiempo`}
    >
      <div className="chart-toolbar">
        <div className="chart-legend" aria-label="Series del gráfico">
          {showSpeed && <span><i className="legend-speed" /> Velocidad</span>}
          {showAcceleration && <span><i className="legend-acceleration" /> Aceleración</span>}
          {hasChartMetrics && gaps.length > 0 && <span><i className="legend-gap" /> Sin datos</span>}
        </div>
        <button
          className="chart-reset"
          type="button"
          onClick={() => {
            setRange(null);
            setSelectedSample(null);
          }}
          disabled={!range || !hasChartMetrics}
        >
          Ver todo
        </button>
      </div>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${chartDescription} versus tiempo`}
        onWheel={zoomWithWheel}
      >
        <defs>
          <clipPath id="plot-area">
            <rect
              x={padding.left}
              y={padding.top}
              width={width - padding.left - padding.right}
              height={height - padding.top - padding.bottom}
            />
          </clipPath>
        </defs>
        {showSpeed && yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              className="grid-line"
              x1={padding.left}
              x2={width - padding.right}
              y1={geometry.y(tick)}
              y2={geometry.y(tick)}
            />
            <text
              className="tick-label"
              x={padding.left - 10}
              y={geometry.y(tick) + 4}
              textAnchor="end"
            >
              {Math.round(tick)}
            </text>
          </g>
        ))}
        {showAcceleration && accelerationTicks.map((tick) => (
          <text
            className="tick-label acceleration-tick"
            key={`a-${tick}`}
            x={width - padding.right + 10}
            y={geometry.accelerationY(tick) + 4}
            textAnchor="start"
          >
            {tick.toFixed(tick % 1 === 0 ? 0 : 1)}
          </text>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line
              className="grid-line"
              x1={geometry.x(tick)}
              x2={geometry.x(tick)}
              y1={padding.top}
              y2={height - padding.bottom}
            />
            <text
              className="tick-label"
              x={geometry.x(tick)}
              y={height - 18}
              textAnchor="middle"
            >
              {Math.round(tick)}
            </text>
          </g>
        ))}
        {showSpeed && <text className="axis-label" x={padding.left} y={12}>km/h</text>}
        {showAcceleration && (
          <text className="axis-label acceleration-axis" x={width - padding.right} y={12} textAnchor="end">
            m/s²
          </text>
        )}
        <text
          className="axis-label"
          x={width - padding.right}
          y={height - 4}
          textAnchor="end"
        >
          segundos
        </text>
        <g clipPath="url(#plot-area)">
          {hasChartMetrics && gaps.map((gap) => (
            <g key={`${gap.start}-${gap.end}`}>
              <rect
                className="gap-area"
                x={geometry.x(gap.start)}
                y={padding.top}
                width={Math.max(2, geometry.x(gap.end) - geometry.x(gap.start))}
                height={height - padding.top - padding.bottom}
              />
              {geometry.x(gap.end) - geometry.x(gap.start) > 62 && (
                <text
                  className="gap-label"
                  x={(geometry.x(gap.start) + geometry.x(gap.end)) / 2}
                  y={padding.top + 17}
                  textAnchor="middle"
                >
                  sin datos
                </text>
              )}
            </g>
          ))}
          {showAcceleration && (
            <line
              className="acceleration-zero-line"
              x1={padding.left}
              x2={width - padding.right}
              y1={geometry.accelerationY(0)}
              y2={geometry.accelerationY(0)}
            />
          )}
          {showSpeed && geometry.groups.map((group) => {
            const points = group
              .map((sample) => `${geometry.x(sample.time)},${geometry.y(sample.speed)}`)
              .join(' ');
            return group.length > 1 ? (
              <polyline
                className="speed-line"
                key={`speed-${group[0].segment}`}
                points={points}
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <circle
                className="speed-dot"
                key={`speed-${group[0].segment}`}
                cx={geometry.x(group[0].time)}
                cy={geometry.y(group[0].speed)}
                r="5"
              />
            );
          })}
          {showAcceleration && geometry.groups.map((group) => {
            const accelerationSamples = group.filter(
              (sample): sample is Sample & { acceleration: number } =>
                sample.acceleration !== null,
            );
            if (accelerationSamples.length === 0) return null;
            const points = accelerationSamples
              .map(
                (sample) =>
                  `${geometry.x(sample.time)},${geometry.accelerationY(sample.acceleration)}`,
              )
              .join(' ');
            return accelerationSamples.length > 1 ? (
              <polyline
                className="acceleration-line"
                key={`acceleration-${group[0].segment}`}
                points={points}
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <circle
                className="acceleration-dot"
                key={`acceleration-${group[0].segment}`}
                cx={geometry.x(accelerationSamples[0].time)}
                cy={geometry.accelerationY(accelerationSamples[0].acceleration)}
                r="4"
              />
            );
          })}
          {selectedVisible && (
            <g aria-hidden="true">
              <line
                className="selection-line"
                x1={geometry.x(selectedVisible.time)}
                x2={geometry.x(selectedVisible.time)}
                y1={padding.top}
                y2={height - padding.bottom}
              />
              {showSpeed && (
                <circle
                  className="selection-speed-dot"
                  cx={geometry.x(selectedVisible.time)}
                  cy={geometry.y(selectedVisible.speed)}
                  r="7"
                />
              )}
              {showAcceleration && selectedVisible.acceleration !== null && (
                <circle
                  className="selection-acceleration-dot"
                  cx={geometry.x(selectedVisible.time)}
                  cy={geometry.accelerationY(selectedVisible.acceleration)}
                  r="6"
                />
              )}
            </g>
          )}
        </g>
        <rect
          className="chart-interaction"
          x={padding.left}
          y={padding.top}
          width={width - padding.left - padding.right}
          height={height - padding.top - padding.bottom}
          onPointerDown={beginGesture}
          onPointerMove={moveGesture}
          onPointerUp={(event) => endGesture(event)}
          onPointerCancel={(event) => endGesture(event, true)}
        />
      </svg>
      {!hasChartMetrics && (
        <p className="chart-empty">Elegí al menos una métrica desde Configuración.</p>
      )}
      {hasChartMetrics && samples.length === 0 && (
        <p className="chart-empty">El gráfico aparecerá con la primera posición GPS.</p>
      )}
      {hasChartMetrics && selectedVisible ? (
        <div
          className={`chart-readout readout-items-${1 + Number(showSpeed) + Number(showAcceleration)}`}
          role="status"
          aria-live="polite"
        >
          <span><small>Tiempo</small>{selectedVisible.time.toFixed(1)} s</span>
          {showSpeed && (
            <span><small>Velocidad</small>{selectedVisible.speed.toFixed(1)} km/h</span>
          )}
          {showAcceleration && (
            <span>
              <small>Aceleración</small>
              {selectedVisible.acceleration === null
                ? '—'
                : `${selectedVisible.acceleration >= 0 ? '+' : ''}${selectedVisible.acceleration.toFixed(2)} m/s²`}
            </span>
          )}
        </div>
      ) : (
        hasChartMetrics && samples.length > 0 && (
          <p className="chart-hint">Pellizcá para ampliar · arrastrá para recorrer · tocá un punto</p>
        )
      )}
    </div>
  );
}

export default function Home() {
  const [isTracking, setIsTracking] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [acceleration, setAcceleration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [distance, setDistance] = useState(0);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [status, setStatus] = useState('Listo para empezar');
  const [error, setError] = useState('');
  const [isMainSpeedVisible, setIsMainSpeedVisible] = useState(true);
  const [isScreenAwake, setIsScreenAwake] = useState(false);
  const [settings, setSettings] = useState<MetricSettings>(DEFAULT_SETTINGS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const watchId = useRef<number | null>(null);
  const simulationTimer = useRef<number | null>(null);
  const speedPanel = useRef<HTMLElement | null>(null);
  const wakeLock = useRef<ScreenWakeLockSentinel | null>(null);
  const wakeLockPending = useRef(false);
  const startTime = useRef(0);
  const previousReading = useRef<Reading | null>(null);
  const previousMotionSample = useRef<{ timestamp: number; speed: number } | null>(null);
  const backgroundGapStart = useRef<number | null>(null);
  const segmentNumber = useRef(0);
  const distanceMeters = useRef(0);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSettings(readStoredSettings()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!isSettingsOpen) return;

    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSettingsOpen(false);
    };
    document.addEventListener('keydown', closeWithEscape);
    return () => document.removeEventListener('keydown', closeWithEscape);
  }, [isSettingsOpen]);

  const storeSettings = (nextSettings: MetricSettings) => {
    setSettings(nextSettings);
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
    } catch {
      // The preferences still work for the current session when storage is unavailable.
    }
  };

  const toggleChartMetric = (metric: ChartMetric) => {
    const selected = settings.chart.includes(metric);
    storeSettings({
      ...settings,
      chart: selected
        ? settings.chart.filter((current) => current !== metric)
        : [...settings.chart, metric],
    });
  };

  const toggleFloatingMetric = (metric: FloatingMetric) => {
    const selected = settings.floating.includes(metric);
    storeSettings({
      ...settings,
      floating: selected
        ? settings.floating.filter((current) => current !== metric)
        : [...settings.floating, metric],
    });
  };

  const acquireScreenWakeLock = useCallback(async () => {
    const wakeLockApi = (navigator as NavigatorWithWakeLock).wakeLock;
    if (
      !wakeLockApi ||
      document.visibilityState !== 'visible' ||
      wakeLock.current ||
      wakeLockPending.current
    ) {
      return;
    }

    wakeLockPending.current = true;
    try {
      const sentinel = await wakeLockApi.request('screen');
      wakeLock.current = sentinel;
      setIsScreenAwake(true);
      sentinel.addEventListener(
        'release',
        () => {
          if (wakeLock.current === sentinel) wakeLock.current = null;
          setIsScreenAwake(false);
        },
        { once: true },
      );
    } catch {
      setIsScreenAwake(false);
    } finally {
      wakeLockPending.current = false;
    }
  }, []);

  const releaseScreenWakeLock = useCallback(() => {
    const sentinel = wakeLock.current;
    wakeLock.current = null;
    wakeLockPending.current = false;
    setIsScreenAwake(false);
    if (sentinel && !sentinel.released) {
      void sentinel.release().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!isTracking) return;

    const timer = window.setInterval(() => {
      setElapsed((Date.now() - startTime.current) / 1000);
    }, 250);

    return () => window.clearInterval(timer);
  }, [isTracking]);

  useEffect(() => {
    if (!isTracking) return;

    const reacquireWhenVisible = () => {
      if (document.visibilityState === 'visible') void acquireScreenWakeLock();
    };

    document.addEventListener('visibilitychange', reacquireWhenVisible);

    return () => {
      document.removeEventListener('visibilitychange', reacquireWhenVisible);
      releaseScreenWakeLock();
    };
  }, [acquireScreenWakeLock, isTracking, releaseScreenWakeLock]);

  useEffect(() => {
    if (!isTracking) return;

    const registerVisibilityGap = () => {
      const currentElapsed = Math.max(0, (Date.now() - startTime.current) / 1000);

      if (document.visibilityState === 'hidden') {
        backgroundGapStart.current ??= currentElapsed;
        return;
      }

      const gapStart = backgroundGapStart.current;
      if (gapStart === null) return;

      backgroundGapStart.current = null;
      segmentNumber.current += 1;
      previousReading.current = null;
      previousMotionSample.current = null;
      setAcceleration(0);
      setElapsed(currentElapsed);

      const gapDuration = currentElapsed - gapStart;
      if (gapDuration >= 0.5) {
        setGaps((currentGaps) => [
          ...currentGaps,
          { start: gapStart, end: currentElapsed },
        ]);
        setStatus(`Retomando GPS · ${Math.round(gapDuration)} s sin datos`);
      }
    };

    document.addEventListener('visibilitychange', registerVisibilityGap);
    return () => document.removeEventListener('visibilitychange', registerVisibilityGap);
  }, [isTracking]);

  useEffect(() => {
    return () => {
      if (watchId.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchId.current);
      }
      if (simulationTimer.current !== null) {
        window.clearInterval(simulationTimer.current);
      }
      releaseScreenWakeLock();
    };
  }, [releaseScreenWakeLock]);

  useEffect(() => {
    const panel = speedPanel.current;
    if (!panel || !('IntersectionObserver' in window)) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsMainSpeedVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(panel);

    return () => observer.disconnect();
  }, []);

  const stopTracking = () => {
    if (watchId.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (simulationTimer.current !== null) {
      window.clearInterval(simulationTimer.current);
      simulationTimer.current = null;
    }
    setElapsed(startTime.current ? (Date.now() - startTime.current) / 1000 : 0);
    setSpeed(0);
    setAcceleration(0);
    setIsTracking(false);
    setStatus('Medición detenida');
    backgroundGapStart.current = null;
  };

  const startTracking = () => {
    setError('');

    if (!('geolocation' in navigator)) {
      setError('Este navegador no tiene GPS disponible.');
      setStatus('No se pudo iniciar');
      return;
    }

    setSamples([]);
    setGaps([]);
    setSpeed(0);
    setAcceleration(0);
    setElapsed(0);
    setDistance(0);
    distanceMeters.current = 0;
    previousReading.current = null;
    previousMotionSample.current = null;
    backgroundGapStart.current = null;
    segmentNumber.current = 0;
    startTime.current = Date.now();
    setIsTracking(true);
    setStatus('Buscando señal GPS…');
    void acquireScreenWakeLock();

    const handlePosition = (position: PositionLike) => {
        if (document.visibilityState === 'hidden') return;

        const current: Reading = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        };
        const previous = previousReading.current;
        let derivedSpeed: number | null = null;

        if (previous) {
          const deltaSeconds = (current.timestamp - previous.timestamp) / 1000;
          const segmentMeters = haversineMeters(previous, current);
          const segmentSpeed = deltaSeconds > 0 ? segmentMeters / deltaSeconds : Infinity;
          const noiseFloor = Math.max(2, (previous.accuracy + current.accuracy) * 0.15);
          const segmentIsPlausible =
            deltaSeconds > 0 &&
            deltaSeconds <= 120 &&
            segmentSpeed <= MAX_PLAUSIBLE_SPEED_MPS &&
            previous.accuracy <= MAX_ACCEPTABLE_ACCURACY_METERS &&
            current.accuracy <= MAX_ACCEPTABLE_ACCURACY_METERS;

          if (segmentIsPlausible) {
            derivedSpeed = segmentSpeed;
            if (segmentMeters >= noiseFloor) {
              distanceMeters.current += segmentMeters;
              setDistance(distanceMeters.current);
            }
          }
        }

        const nativeSpeed = position.coords.speed;
        const usableNativeSpeed =
          typeof nativeSpeed === 'number' &&
          Number.isFinite(nativeSpeed) &&
          nativeSpeed >= 0 &&
          nativeSpeed <= MAX_PLAUSIBLE_SPEED_MPS
            ? nativeSpeed
            : null;
        const metersPerSecond = usableNativeSpeed ?? derivedSpeed ?? 0;
        const speedKmh = metersPerSecond * 3.6;
        const timeSeconds = Math.max(0, (position.timestamp - startTime.current) / 1000);
        const previousMotion = previousMotionSample.current;
        let accelerationMps2: number | null = null;

        if (previousMotion) {
          const motionDeltaSeconds = (current.timestamp - previousMotion.timestamp) / 1000;
          const rawAcceleration =
            motionDeltaSeconds > 0
              ? (metersPerSecond - previousMotion.speed) / motionDeltaSeconds
              : Infinity;
          if (
            motionDeltaSeconds >= 0.25 &&
            motionDeltaSeconds <= 15 &&
            Math.abs(rawAcceleration) <= MAX_PLAUSIBLE_ACCELERATION_MPS2
          ) {
            accelerationMps2 = rawAcceleration;
          }
        }

        setSpeed(speedKmh);
        setAcceleration(accelerationMps2 ?? 0);
        setElapsed(Math.max(0, (Date.now() - startTime.current) / 1000));
        setSamples((currentSamples) => [
          ...currentSamples,
          {
            time: timeSeconds,
            speed: speedKmh,
            acceleration: accelerationMps2,
            segment: segmentNumber.current,
          },
        ]);
        setStatus(`GPS activo · precisión ${Math.round(current.accuracy)} m`);
        setError('');
        previousReading.current = current;
        previousMotionSample.current =
          usableNativeSpeed !== null || derivedSpeed !== null
            ? { timestamp: current.timestamp, speed: metersPerSecond }
            : null;
      };

    // Local-only deterministic GPS feed used by the browser validation pass.
    if (
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).has('simulateGps')
    ) {
      let index = 0;
      const simulatedLatitude = 0;
      let longitude = 0;
      const simulateGap = new URLSearchParams(window.location.search).has('simulateGap');
      const emitPosition = () => {
        if (simulateGap && index === 4) {
          setGaps([{ start: 4, end: 9 }]);
          segmentNumber.current += 1;
          previousReading.current = null;
          previousMotionSample.current = null;
          index = 9;
        }
        const simulatedSpeed = Math.max(0, 3.4 + Math.sin(index / 2.4) * 2.1);
        if (index > 0) {
          longitude += simulatedSpeed / 111_320;
        }
        handlePosition({
          timestamp: startTime.current + index * 1000,
          coords: {
            latitude: simulatedLatitude,
            longitude,
            accuracy: 5,
            speed: simulatedSpeed,
          },
        });
        index += 1;
      };
      emitPosition();
      simulationTimer.current = window.setInterval(emitPosition, 1000);
      return;
    }

    watchId.current = navigator.geolocation.watchPosition(
      handlePosition,
      (geolocationError) => {
        const messages: Record<number, string> = {
          1: 'Permiso de ubicación denegado. Habilitalo en Ajustes de Safari y volvé a intentar.',
          2: 'No se pudo obtener señal GPS. Probá en un lugar abierto.',
          3: 'El GPS tardó demasiado en responder. Volvé a intentar.',
        };
        setError(messages[geolocationError.code] ?? 'Ocurrió un problema al acceder al GPS.');
        stopTracking();
        setStatus('No se pudo medir');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15_000,
      },
    );
  };

  const formattedDistance = formatDistance(distance);
  const showSpeedInChart = settings.chart.includes('speed');
  const showAccelerationInChart = settings.chart.includes('acceleration');
  const chartMetricLabel = showSpeedInChart
    ? showAccelerationInChart
      ? 'velocidad y aceleración'
      : 'velocidad'
    : showAccelerationInChart
      ? 'aceleración'
      : 'sin métricas';

  return (
    <main className="app-shell">
      <button
        className={`settings-toggle ${isSettingsOpen ? 'is-open' : ''}`}
        type="button"
        aria-label={isSettingsOpen ? 'Cerrar configuración' : 'Abrir configuración'}
        aria-expanded={isSettingsOpen}
        aria-controls="settings-panel"
        onClick={() => setIsSettingsOpen((open) => !open)}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <i className={`settings-gps-status ${isTracking ? 'is-active' : ''}`} aria-hidden="true" />
      </button>

      {isSettingsOpen && (
        <>
          <button
            className="settings-backdrop"
            type="button"
            aria-label="Cerrar configuración"
            onClick={() => setIsSettingsOpen(false)}
          />
          <section
            id="settings-panel"
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-heading">
              <div>
                <p>PERSONALIZAR</p>
                <h2 id="settings-title">Configuración</h2>
              </div>
              <small>Se guarda en este teléfono</small>
            </div>

            <fieldset className="settings-group">
              <legend>Mostrar en el gráfico</legend>
              <p>Elegí las líneas que querés comparar.</p>
              {CHART_METRICS.map((metric) => (
                <label className="settings-option" key={`chart-${metric.id}`}>
                  <span>
                    <strong>{metric.label}</strong>
                    <small>{metric.detail}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.chart.includes(metric.id)}
                    onChange={() => toggleChartMetric(metric.id)}
                  />
                  <i aria-hidden="true" />
                </label>
              ))}
            </fieldset>

            <fieldset className="settings-group">
              <legend>Métricas flotantes</legend>
              <p>Aparecen cuando el velocímetro principal sale de la pantalla.</p>
              {FLOATING_METRICS.map((metric) => (
                <label className="settings-option" key={`floating-${metric.id}`}>
                  <span>
                    <strong>{metric.label}</strong>
                    <small>{metric.detail}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.floating.includes(metric.id)}
                    onChange={() => toggleFloatingMetric(metric.id)}
                  />
                  <i aria-hidden="true" />
                </label>
              ))}
            </fieldset>

            <button
              className="settings-reset"
              type="button"
              onClick={() => storeSettings(DEFAULT_SETTINGS)}
            >
              Restablecer valores por defecto
            </button>
          </section>
        </>
      )}

      {!isMainSpeedVisible && settings.floating.length > 0 && (
        <aside className="floating-metrics" aria-label="Métricas flotantes">
          {settings.floating.includes('speed') && (
            <div className="floating-metric is-speed">
              <span>Velocidad</span>
              <p><strong>{speed.toFixed(1)}</strong><small>km/h</small></p>
            </div>
          )}
          {settings.floating.includes('acceleration') && (
            <div className="floating-metric">
              <span>Aceleración</span>
              <p>
                <strong>{acceleration > 0 ? '+' : ''}{acceleration.toFixed(2)}</strong>
                <small>m/s²</small>
              </p>
            </div>
          )}
          {settings.floating.includes('time') && (
            <div className="floating-metric">
              <span>Tiempo</span>
              <p><strong>{formatTime(elapsed)}</strong></p>
            </div>
          )}
          {settings.floating.includes('distance') && (
            <div className="floating-metric">
              <span>Distancia</span>
              <p><strong>{formattedDistance}</strong></p>
            </div>
          )}
        </aside>
      )}

      <header className="topbar">
        <div>
          <p className="eyebrow">VELOCÍMETRO · GPS</p>
          <h1>Velocidad en vivo</h1>
        </div>
      </header>

      <section ref={speedPanel} className="speed-panel" aria-label="Velocidad actual">
        <div className="speed-reading" aria-live="polite">
          <span>{speed.toFixed(1)}</span>
          <small>km/h</small>
        </div>
        <p className="status-text">{status}</p>
        {isScreenAwake && (
          <p className="awake-status"><span aria-hidden="true" /> Pantalla activa</p>
        )}
      </section>

      {error && <p className="error-message" role="alert">{error}</p>}

      <section className="metrics" aria-label="Resumen del recorrido">
        <div>
          <span>Tiempo</span>
          <strong>{formatTime(elapsed)}</strong>
        </div>
        <div>
          <span>Distancia</span>
          <strong>{formattedDistance}</strong>
        </div>
        <div>
          <span>Aceleración</span>
          <strong className="acceleration-value">
            {acceleration > 0 ? '+' : ''}{acceleration.toFixed(2)} <small>m/s²</small>
          </strong>
        </div>
      </section>

      <section className="chart-card">
        <div className="chart-heading">
          <h2>Movimiento</h2>
          <span>{chartMetricLabel}</span>
        </div>
        <SpeedChart
          samples={samples}
          gaps={gaps}
          elapsed={elapsed}
          showSpeed={showSpeedInChart}
          showAcceleration={showAccelerationInChart}
        />
        {gaps.length > 0 && (
          <p className="gap-note">
            {gaps.length === 1 ? '1 intervalo' : `${gaps.length} intervalos`} sin GPS ·{' '}
            {formatTime(gaps.reduce((total, gap) => total + gap.end - gap.start, 0))}
          </p>
        )}
      </section>

      <section className="controls" aria-label="Controles de medición">
        <button
          className="button button-start"
          type="button"
          onClick={startTracking}
          disabled={isTracking}
        >
          Empezar
        </button>
        <button
          className="button button-stop"
          type="button"
          onClick={stopTracking}
          disabled={!isTracking}
        >
          Parar
        </button>
      </section>

      <p className="safety-note">
        Mantené el teléfono seguro y no interactúes con la pantalla mientras estás en movimiento.
      </p>
    </main>
  );
}
