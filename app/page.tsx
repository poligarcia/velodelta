import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import {
  InvalidSessionFileError,
  parseSessionJson,
  serializeSession,
  type ChartMetric,
  type FloatingMetric,
  type SessionPoint,
  type SessionSettings,
} from '../lib/session';
import {
  clamp,
  formatDistance,
  formatTime,
  haversineMeters,
  type Reading,
} from '../lib/tracking';
import {
  averageAccelerationMps2,
  derivativeConvergence,
  eligibleDerivativePointIndices,
  findAccelerationReferenceIndex,
  type DerivativeConvergence,
  type DerivativeSample,
} from '../lib/derivative';

type Sample = {
  time: number;
  speed: number;
  acceleration: number | null;
  segment: number;
};

type Gap = { start: number; end: number };
type ChartRange = { start: number; end: number };

const MAX_PLAUSIBLE_SPEED_MPS = 25;
const MAX_PLAUSIBLE_ACCELERATION_MPS2 = 12;
const MAX_ACCEPTABLE_ACCURACY_METERS = 80;
const MAX_SESSION_FILE_BYTES = 25_000_000;
const SETTINGS_STORAGE_KEY = 'velocimetro-settings-v1';
const DEFAULT_SETTINGS: SessionSettings = {
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

function readStoredSettings(): SessionSettings {
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
  analysisAvailable,
  onAnalysisModeChange,
}: {
  samples: Sample[];
  gaps: Gap[];
  elapsed: number;
  showSpeed: boolean;
  showAcceleration: boolean;
  analysisAvailable: boolean;
  onAnalysisModeChange: (active: boolean) => void;
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
  const [derivativeMode, setDerivativeMode] = useState(false);
  const [selectingDerivativePoint, setSelectingDerivativePoint] = useState(false);
  const [derivativePointIndex, setDerivativePointIndex] = useState<number | null>(null);
  const [derivativeDraftPointIndex, setDerivativeDraftPointIndex] = useState<number | null>(null);
  const [derivativeQIndex, setDerivativeQIndex] = useState<number | null>(null);
  const savedChartState = useRef<{
    range: ChartRange | null;
    selectedSample: Sample | null;
  } | null>(null);
  const gesture = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    startRange: null as ChartRange | null,
    startDistance: 0,
    startMidpoint: 0,
    startX: 0,
    moved: false,
  });
  const effectiveShowSpeed = derivativeMode ? true : showSpeed;
  const effectiveShowAcceleration = derivativeMode ? false : showAcceleration;
  const hasChartMetrics = effectiveShowSpeed || effectiveShowAcceleration;
  const chartDescription = effectiveShowSpeed
    ? effectiveShowAcceleration
      ? 'velocidad y aceleración'
      : 'velocidad'
    : effectiveShowAcceleration
      ? 'aceleración'
      : 'ninguna métrica';
  const derivativeSamples = useMemo<DerivativeSample[]>(
    () => samples.map((sample) => ({
      time: sample.time,
      speedKmh: sample.speed,
      accelerationMps2: sample.acceleration,
      segment: sample.segment,
    })),
    [samples],
  );
  const derivativePointOptions = useMemo(
    () => eligibleDerivativePointIndices(derivativeSamples),
    [derivativeSamples],
  );
  const derivativeDragPointer = useRef<number | null>(null);
  const derivativeSelectionPointer = useRef<number | null>(null);

  useEffect(
    () => () => onAnalysisModeChange(false),
    [onAnalysisModeChange],
  );

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

  const derivativePoint = derivativePointIndex === null
    ? null
    : derivativeSamples[derivativePointIndex] ?? null;
  const derivativeDraftPoint = derivativeDraftPointIndex === null
    ? null
    : derivativeSamples[derivativeDraftPointIndex] ?? null;
  const visibleDerivativePointOptions = useMemo(
    () => derivativePointOptions.filter((index) => {
      const point = derivativeSamples[index];
      return point.time >= activeRange.start && point.time <= activeRange.end;
    }),
    [activeRange, derivativePointOptions, derivativeSamples],
  );
  const derivativeReferenceIndex = derivativePointIndex === null
    ? null
    : findAccelerationReferenceIndex(derivativeSamples, derivativePointIndex);
  const derivativeReference = derivativeReferenceIndex === null
    ? null
    : derivativeSamples[derivativeReferenceIndex] ?? null;
  const derivativeQ = derivativeQIndex === null
    ? null
    : derivativeSamples[derivativeQIndex] ?? null;
  const derivativeQOptions = useMemo(() => {
    if (derivativePointIndex === null) return [];
    const referenceIndex = findAccelerationReferenceIndex(
      derivativeSamples,
      derivativePointIndex,
    );
    const point = derivativeSamples[derivativePointIndex];
    if (referenceIndex === null || !point) return [];

    const options: number[] = [];
    for (let index = referenceIndex; index >= 0; index -= 1) {
      if (derivativeSamples[index].segment !== point.segment) break;
      options.unshift(index);
    }
    return options;
  }, [derivativePointIndex, derivativeSamples]);
  const derivativeQPosition = derivativeQIndex === null
    ? -1
    : derivativeQOptions.indexOf(derivativeQIndex);
  const derivativeAverage = derivativePoint && derivativeQ
    ? averageAccelerationMps2(derivativeQ, derivativePoint)
    : null;
  const derivativeDeltaSeconds = derivativePoint && derivativeQ
    ? derivativePoint.time - derivativeQ.time
    : 0;
  const derivativeDeltaSpeedKmh = derivativePoint && derivativeQ
    ? derivativePoint.speedKmh - derivativeQ.speedKmh
    : 0;
  const derivativeReferenceDeltaSeconds = derivativePoint && derivativeReference
    ? derivativePoint.time - derivativeReference.time
    : 0;
  const derivativeState: DerivativeConvergence = derivativePoint
    ? derivativeConvergence(
        derivativeAverage,
        derivativePoint.accelerationMps2,
        derivativeDeltaSeconds,
        derivativeReferenceDeltaSeconds,
      )
    : 'far';
  const derivativeDifference = derivativePoint && derivativeAverage !== null
    ? Math.abs(derivativeAverage - (derivativePoint.accelerationMps2 ?? 0))
    : null;

  const setRangeCenteredOn = (centerTime: number, requestedSpan: number) => {
    const span = clamp(requestedSpan, 5, domainMax);
    if (span >= domainMax * 0.995) {
      setRange(null);
      return;
    }
    const start = clamp(centerTime - span / 2, 0, Math.max(0, domainMax - span));
    setRange({ start, end: start + span });
  };

  const derivativeIndexFromClient = (clientX: number, element: SVGSVGElement) => {
    if (visibleDerivativePointOptions.length === 0) return null;
    const targetTime = timeFromClient(clientX, element, activeRange);
    return visibleDerivativePointOptions.reduce((best, index) =>
      Math.abs(derivativeSamples[index].time - targetTime) <
      Math.abs(derivativeSamples[best].time - targetTime)
        ? index
        : best,
    );
  };

  const chooseDerivativePoint = (index: number) => {
    const point = derivativeSamples[index];
    const referenceIndex = findAccelerationReferenceIndex(derivativeSamples, index);
    if (!point || referenceIndex === null) return;

    const candidates: number[] = [];
    for (let candidate = referenceIndex; candidate >= 0; candidate -= 1) {
      if (derivativeSamples[candidate].segment !== point.segment) break;
      candidates.unshift(candidate);
    }
    if (candidates.length === 0) return;

    const visibleSpan = activeRange.end - activeRange.start;
    const targetTime = point.time - Math.min(5, visibleSpan * 0.3);
    const defaultQ = candidates.reduce((best, candidate) =>
      Math.abs(derivativeSamples[candidate].time - targetTime) <
      Math.abs(derivativeSamples[best].time - targetTime)
        ? candidate
        : best,
    );

    setDerivativePointIndex(index);
    setDerivativeQIndex(defaultQ);
    setSelectingDerivativePoint(false);
    setDerivativeDraftPointIndex(null);
    setRangeCenteredOn(point.time, visibleSpan);
  };

  const updateDerivativeQ = (index: number) => {
    if (!derivativePoint || !derivativeReference || !derivativeQOptions.includes(index)) return;
    setDerivativeQIndex(index);
  };

  const updateDerivativeQFromClient = (clientX: number, element: SVGSVGElement) => {
    if (derivativeQOptions.length === 0) return;
    const targetTime = timeFromClient(clientX, element, activeRange);
    const nearest = derivativeQOptions.reduce((best, index) =>
      Math.abs(derivativeSamples[index].time - targetTime) <
      Math.abs(derivativeSamples[best].time - targetTime)
        ? index
        : best,
    );
    updateDerivativeQ(nearest);
  };

  const enterDerivativeMode = () => {
    savedChartState.current = { range, selectedSample };
    setSelectedSample(null);
    setDerivativeMode(true);
    onAnalysisModeChange(true);
    setSelectingDerivativePoint(true);
    setDerivativePointIndex(null);
    setDerivativeDraftPointIndex(null);
    setDerivativeQIndex(null);
  };

  const exitDerivativeMode = () => {
    const saved = savedChartState.current;
    setRange(saved?.range ?? null);
    setSelectedSample(saved?.selectedSample ?? null);
    setDerivativeMode(false);
    onAnalysisModeChange(false);
    setSelectingDerivativePoint(false);
    setDerivativePointIndex(null);
    setDerivativeDraftPointIndex(null);
    setDerivativeQIndex(null);
    savedChartState.current = null;
  };

  const derivativePlot = (() => {
    if (
      !derivativePoint ||
      !derivativeQ ||
      derivativeAverage === null ||
      derivativePoint.accelerationMps2 === null
    ) {
      return null;
    }

    const plotLeft = padding.left;
    const plotRight = width - padding.right;
    const secantSpeedAt = (time: number) =>
      derivativePoint.speedKmh +
      (time - derivativePoint.time) * derivativeAverage * 3.6;
    const pointX = geometry.x(derivativePoint.time);
    const pointY = geometry.y(derivativePoint.speedKmh);
    const qX = geometry.x(derivativeQ.time);
    const qY = geometry.y(derivativeQ.speedKmh);

    return {
      pointX,
      pointY,
      qX,
      qY,
      secant: {
        x1: plotLeft,
        y1: geometry.y(secantSpeedAt(activeRange.start)),
        x2: plotRight,
        y2: geometry.y(secantSpeedAt(activeRange.end)),
      },
    };
  })();

  return (
    <div
      ref={chartContainer}
      className="chart-wrap"
      aria-label={`Gráfico interactivo de ${chartDescription} versus tiempo`}
    >
      <div className="chart-toolbar">
        <div className="chart-legend" aria-label="Series del gráfico">
          {effectiveShowSpeed && <span><i className="legend-speed" /> Velocidad</span>}
          {effectiveShowAcceleration && <span><i className="legend-acceleration" /> Aceleración</span>}
          {derivativeMode && derivativePoint && !selectingDerivativePoint && (
            <span>
              <i className={`legend-derivative is-${derivativeState}`} />
              {derivativeState === 'converged' ? '≈ Tangente en P' : 'Secante'}
            </span>
          )}
          {hasChartMetrics && gaps.length > 0 && <span><i className="legend-gap" /> Sin datos</span>}
        </div>
        <div className="chart-actions">
          {!derivativeMode && (
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
          )}
          {!derivativeMode && analysisAvailable && derivativePointOptions.length > 0 && (
            <button className="chart-derivative-enter" type="button" onClick={enterDerivativeMode}>
              Explorar derivada
            </button>
          )}
          {derivativeMode && (
            <>
              <button
                className="chart-reset"
                type="button"
                aria-pressed={selectingDerivativePoint}
                onClick={() => {
                  setDerivativeDraftPointIndex(null);
                  setSelectingDerivativePoint((selecting) => !selecting);
                }}
              >
                {derivativePoint ? 'Cambiar P' : 'Elegir P'}
              </button>
              <button className="chart-derivative-exit" type="button" onClick={exitDerivativeMode}>
                Salir
              </button>
            </>
          )}
        </div>
      </div>
      {derivativeMode && selectingDerivativePoint && (
        <p className="derivative-instruction" role="status">
          {visibleDerivativePointOptions.length === 0
            ? 'No hay puntos con aceleración calculable en este encuadre. Salí y alejá el zoom.'
            : derivativeDraftPoint
              ? `P provisional · ${derivativeDraftPoint.time.toFixed(1)} s · ${derivativeDraftPoint.speedKmh.toFixed(1)} km/h`
              : derivativePoint
                ? 'Deslizá horizontalmente para mover P y soltá para fijarla.'
                : 'Deslizá horizontalmente para elegir P y soltá para fijarla.'}
        </p>
      )}
      {derivativeMode && derivativePoint && derivativeAverage !== null && !selectingDerivativePoint && (
        <>
          <div className="derivative-comparison" aria-live="polite">
            <span>
              <small>Aceleración promedio P,Q</small>
              <strong>{derivativeAverage >= 0 ? '+' : ''}{derivativeAverage.toFixed(2)} <i>m/s²</i></strong>
            </span>
            <span>
              <small>Aceleración en P</small>
              <strong>
                {(derivativePoint.accelerationMps2 ?? 0) >= 0 ? '+' : ''}
                {(derivativePoint.accelerationMps2 ?? 0).toFixed(2)} <i>m/s²</i>
              </strong>
            </span>
          </div>
          <p className={`derivative-state is-${derivativeState}`} aria-live="polite">
            {derivativeState === 'converged'
              ? `≈ Coinciden · diferencia ${derivativeDifference?.toFixed(2)} m/s²`
              : derivativeDifference !== null && derivativeDifference <= 0.05
                ? `Casi coinciden · diferencia ${derivativeDifference.toFixed(2)} m/s²`
                : `Todavía no coinciden · diferencia ${derivativeDifference?.toFixed(2)} m/s²`}
          </p>
          <div className="derivative-zoom-controls" aria-label="Zoom centrado en P">
            <button
              type="button"
              aria-label="Alejar el gráfico manteniendo P centrada"
              onClick={() => setRangeCenteredOn(
                derivativePoint.time,
                (activeRange.end - activeRange.start) * 1.5,
              )}
              disabled={activeRange.end - activeRange.start >= domainMax * 0.995}
            >
              −
            </button>
            <span>
              <small>P centrada</small>
              <strong>{derivativePoint.time.toFixed(1)} s</strong>
            </span>
            <button
              type="button"
              aria-label="Acercar el gráfico manteniendo P centrada"
              onClick={() => setRangeCenteredOn(
                derivativePoint.time,
                (activeRange.end - activeRange.start) / 1.5,
              )}
              disabled={activeRange.end - activeRange.start <= 5.005}
            >
              +
            </button>
          </div>
        </>
      )}
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${chartDescription} versus tiempo`}
        onWheel={derivativeMode ? undefined : zoomWithWheel}
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
        {effectiveShowSpeed && yTicks.map((tick) => (
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
        {effectiveShowAcceleration && accelerationTicks.map((tick) => (
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
        {effectiveShowSpeed && <text className="axis-label" x={padding.left} y={12}>km/h</text>}
        {effectiveShowAcceleration && (
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
          {effectiveShowAcceleration && (
            <line
              className="acceleration-zero-line"
              x1={padding.left}
              x2={width - padding.right}
              y1={geometry.accelerationY(0)}
              y2={geometry.accelerationY(0)}
            />
          )}
          {effectiveShowSpeed && geometry.groups.map((group) => {
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
          {effectiveShowAcceleration && geometry.groups.map((group) => {
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
              {effectiveShowSpeed && (
                <circle
                  className="selection-speed-dot"
                  cx={geometry.x(selectedVisible.time)}
                  cy={geometry.y(selectedVisible.speed)}
                  r="7"
                />
              )}
              {effectiveShowAcceleration && selectedVisible.acceleration !== null && (
                <circle
                  className="selection-acceleration-dot"
                  cx={geometry.x(selectedVisible.time)}
                  cy={geometry.accelerationY(selectedVisible.acceleration)}
                  r="6"
                />
              )}
            </g>
          )}
          {derivativeMode && selectingDerivativePoint && derivativeDraftPoint && (
            <g aria-hidden="true">
              <line
                className="derivative-p-guide"
                x1={geometry.x(derivativeDraftPoint.time)}
                x2={geometry.x(derivativeDraftPoint.time)}
                y1={padding.top}
                y2={height - padding.bottom}
              />
              <circle
                className="derivative-p-preview"
                cx={geometry.x(derivativeDraftPoint.time)}
                cy={geometry.y(derivativeDraftPoint.speedKmh)}
                r="8"
              />
              <text
                className="derivative-point-label"
                x={geometry.x(derivativeDraftPoint.time)}
                y={geometry.y(derivativeDraftPoint.speedKmh) - 14}
                textAnchor="middle"
              >
                P
              </text>
            </g>
          )}
          {derivativeMode && derivativePlot && !selectingDerivativePoint && (
            <g aria-hidden="true">
              <line
                className={`derivative-secant is-${derivativeState}`}
                x1={derivativePlot.secant.x1}
                y1={derivativePlot.secant.y1}
                x2={derivativePlot.secant.x2}
                y2={derivativePlot.secant.y2}
                vectorEffect="non-scaling-stroke"
              />
              {Math.abs(derivativePlot.pointX - derivativePlot.qX) >= 68 && (
                <path
                  className="derivative-delta"
                  d={`M ${derivativePlot.pointX} ${derivativePlot.pointY} L ${derivativePlot.qX} ${derivativePlot.pointY} L ${derivativePlot.qX} ${derivativePlot.qY}`}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <circle
                className={`derivative-point-p is-${derivativeState}`}
                cx={derivativePlot.pointX}
                cy={derivativePlot.pointY}
                r="7"
              />
              <text
                className="derivative-point-label"
                x={derivativePlot.pointX}
                y={derivativePlot.pointY - 12}
                textAnchor="middle"
              >
                P
              </text>
              <rect
                className={`derivative-point-q is-${derivativeState}`}
                x={derivativePlot.qX - 5.5}
                y={derivativePlot.qY - 5.5}
                width="11"
                height="11"
                rx="2"
                transform={`rotate(45 ${derivativePlot.qX} ${derivativePlot.qY})`}
              />
              <text
                className="derivative-point-label"
                x={derivativePlot.qX}
                y={derivativePlot.qY + 20}
                textAnchor="middle"
              >
                Q
              </text>
            </g>
          )}
        </g>
        {!derivativeMode ? (
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
        ) : (
          <>
            <rect
              className={`chart-interaction derivative-chart-interaction ${selectingDerivativePoint ? 'is-selecting' : ''}`}
              x={padding.left}
              y={padding.top}
              width={width - padding.left - padding.right}
              height={height - padding.top - padding.bottom}
              onPointerDown={(event) => {
                if (!selectingDerivativePoint) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                derivativeSelectionPointer.current = event.pointerId;
                setDerivativeDraftPointIndex(
                  derivativeIndexFromClient(
                    event.clientX,
                    event.currentTarget.ownerSVGElement!,
                  ),
                );
              }}
              onPointerMove={(event) => {
                if (
                  !selectingDerivativePoint ||
                  derivativeSelectionPointer.current !== event.pointerId
                ) {
                  return;
                }
                setDerivativeDraftPointIndex(
                  derivativeIndexFromClient(
                    event.clientX,
                    event.currentTarget.ownerSVGElement!,
                  ),
                );
              }}
              onPointerUp={(event) => {
                const isActivePointer = derivativeSelectionPointer.current === event.pointerId;
                derivativeSelectionPointer.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                if (!selectingDerivativePoint || !isActivePointer) return;
                const selectedIndex = derivativeIndexFromClient(
                  event.clientX,
                  event.currentTarget.ownerSVGElement!,
                );
                if (selectedIndex !== null) chooseDerivativePoint(selectedIndex);
              }}
              onPointerCancel={() => {
                derivativeSelectionPointer.current = null;
                setDerivativeDraftPointIndex(null);
              }}
            />
            {derivativePlot && !selectingDerivativePoint && (
              <circle
                className="derivative-q-hit"
                cx={derivativePlot.qX}
                cy={derivativePlot.qY}
                r="24"
                aria-label={`Mover Q, actualmente en ${derivativeQ?.time.toFixed(1)} segundos`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  derivativeDragPointer.current = event.pointerId;
                  updateDerivativeQFromClient(
                    event.clientX,
                    event.currentTarget.ownerSVGElement!,
                  );
                }}
                onPointerMove={(event) => {
                  if (derivativeDragPointer.current !== event.pointerId) return;
                  event.preventDefault();
                  updateDerivativeQFromClient(
                    event.clientX,
                    event.currentTarget.ownerSVGElement!,
                  );
                }}
                onPointerUp={(event) => {
                  if (derivativeDragPointer.current !== event.pointerId) return;
                  derivativeDragPointer.current = null;
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onPointerCancel={() => {
                  derivativeDragPointer.current = null;
                }}
              />
            )}
          </>
        )}
      </svg>
      {derivativeMode && derivativePoint && derivativeQ && derivativeAverage !== null && !selectingDerivativePoint && (
        <div className="derivative-controls">
          <label className="derivative-rail">
            <span>
              <small>Mover Q hacia P</small>
              <strong>{derivativeQ.time.toFixed(1)} s</strong>
            </span>
            <input
              type="range"
              min="0"
              max={Math.max(0, derivativeQOptions.length - 1)}
              step="1"
              value={Math.max(0, derivativeQPosition)}
              aria-label="Posición temporal del punto Q"
              aria-valuetext={`${derivativeQ.time.toFixed(1)} segundos`}
              onChange={(event) => {
                const next = derivativeQOptions[Number(event.currentTarget.value)];
                if (next !== undefined) updateDerivativeQ(next);
              }}
            />
          </label>
          <p className="derivative-formula">
            Δv / Δt = {(derivativeDeltaSpeedKmh / derivativeDeltaSeconds).toFixed(2)} km/h/s
            {' = '}
            <strong>{derivativeAverage.toFixed(2)} m/s²</strong>
          </p>
          <div className="derivative-deltas">
            <span><small>Δt</small><strong>{derivativeDeltaSeconds.toFixed(1)} s</strong></span>
            <span><small>Δv</small><strong>{derivativeDeltaSpeedKmh.toFixed(2)} km/h</strong></span>
          </div>
          <p className="derivative-hint">
            Arrastrá Q en la curva o usá el riel; ambos controles están sincronizados.
          </p>
        </div>
      )}
      {!hasChartMetrics && (
        <p className="chart-empty">Elegí al menos una métrica desde Configuración.</p>
      )}
      {hasChartMetrics && samples.length === 0 && (
        <p className="chart-empty">El gráfico aparecerá con la primera posición GPS.</p>
      )}
      {!derivativeMode && hasChartMetrics && selectedVisible ? (
        <div
          className={`chart-readout readout-items-${1 + Number(effectiveShowSpeed) + Number(effectiveShowAcceleration)}`}
          role="status"
          aria-live="polite"
        >
          <span><small>Tiempo</small>{selectedVisible.time.toFixed(1)} s</span>
          {effectiveShowSpeed && (
            <span><small>Velocidad</small>{selectedVisible.speed.toFixed(1)} km/h</span>
          )}
          {effectiveShowAcceleration && (
            <span>
              <small>Aceleración</small>
              {selectedVisible.acceleration === null
                ? '—'
                : `${selectedVisible.acceleration >= 0 ? '+' : ''}${selectedVisible.acceleration.toFixed(2)} m/s²`}
            </span>
          )}
        </div>
      ) : (
        !derivativeMode && hasChartMetrics && samples.length > 0 && (
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
  const [samples, setSamples] = useState<SessionPoint[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [status, setStatus] = useState('Listo para empezar');
  const [error, setError] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [sessionEndedAt, setSessionEndedAt] = useState<number | null>(null);
  const [isMainSpeedVisible, setIsMainSpeedVisible] = useState(true);
  const [isScreenAwake, setIsScreenAwake] = useState(false);
  const [settings, setSettings] = useState<SessionSettings>(DEFAULT_SETTINGS);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDerivativeAnalysisActive, setIsDerivativeAnalysisActive] = useState(false);

  const watchId = useRef<number | null>(null);
  const simulationTimer = useRef<number | null>(null);
  const sessionFileInput = useRef<HTMLInputElement | null>(null);
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

  const storeSettings = (nextSettings: SessionSettings) => {
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
    const stoppedAt = Date.now();
    if (watchId.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (simulationTimer.current !== null) {
      window.clearInterval(simulationTimer.current);
      simulationTimer.current = null;
    }
    setElapsed(startTime.current ? (stoppedAt - startTime.current) / 1000 : 0);
    setSpeed(0);
    setAcceleration(0);
    setIsTracking(false);
    setStatus('Medición detenida');
    setSessionEndedAt(stoppedAt);
    backgroundGapStart.current = null;
  };

  const startTracking = () => {
    setError('');
    setSessionError('');
    setSessionNotice('');

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
    setSessionEndedAt(null);
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
        const reportedSpeed =
          typeof nativeSpeed === 'number' && Number.isFinite(nativeSpeed)
            ? nativeSpeed
            : null;
        const usableNativeSpeed =
          reportedSpeed !== null &&
          reportedSpeed >= 0 &&
          reportedSpeed <= MAX_PLAUSIBLE_SPEED_MPS
            ? reportedSpeed
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
            timestampMs: current.timestamp,
            elapsedSeconds: timeSeconds,
            latitude: current.latitude,
            longitude: current.longitude,
            accuracyMeters: current.accuracy,
            reportedSpeedMps: reportedSpeed,
            speedKmh,
            accelerationMps2,
            distanceMeters: distanceMeters.current,
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

  const downloadSession = () => {
    if (isTracking || sessionEndedAt === null || samples.length === 0) return;

    const json = serializeSession({
      startedAtMs: startTime.current,
      endedAtMs: sessionEndedAt,
      finalState: {
        elapsedSeconds: elapsed,
        distanceMeters: distance,
        speedKmh: speed,
        accelerationMps2: acceleration,
      },
      points: samples,
      gaps: gaps.map((gap) => ({
        startSeconds: gap.start,
        endSeconds: gap.end,
      })),
      settings,
    });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date(sessionEndedAt)
      .toISOString()
      .slice(0, 19)
      .replaceAll(':', '-');
    link.href = url;
    link.download = `velodelta-${date}Z.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setSessionNotice(`Sesión descargada · ${samples.length} puntos`);
    setSessionError('');
  };

  const loadSession = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || isTracking) return;

    setSessionNotice('');
    setSessionError('');

    try {
      if (file.size > MAX_SESSION_FILE_BYTES) {
        throw new InvalidSessionFileError('El archivo supera el máximo de 25 MB.');
      }
      const imported = parseSessionJson(await file.text());

      startTime.current = imported.startedAtMs;
      distanceMeters.current = imported.finalState.distanceMeters;
      previousReading.current = null;
      previousMotionSample.current = null;
      backgroundGapStart.current = null;
      segmentNumber.current = imported.points.at(-1)?.segment ?? 0;
      setSamples(imported.points);
      setGaps(imported.gaps.map((gap) => ({
        start: gap.startSeconds,
        end: gap.endSeconds,
      })));
      setElapsed(imported.finalState.elapsedSeconds);
      setDistance(imported.finalState.distanceMeters);
      setSpeed(imported.finalState.speedKmh);
      setAcceleration(imported.finalState.accelerationMps2);
      setSessionEndedAt(imported.endedAtMs);
      storeSettings(imported.settings);
      setStatus(
        `Sesión cargada · ${new Intl.DateTimeFormat('es-AR', {
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(imported.endedAtMs)}`,
      );
      setSessionNotice(`Reconstrucción completa · ${imported.points.length} puntos`);
    } catch (loadError) {
      setSessionError(
        loadError instanceof InvalidSessionFileError
          ? loadError.message
          : 'No se pudo leer el archivo de sesión.',
      );
    } finally {
      input.value = '';
    }
  };

  const formattedDistance = formatDistance(distance);
  const chartSamples = useMemo<Sample[]>(
    () => samples.map((sample) => ({
      time: sample.elapsedSeconds,
      speed: sample.speedKmh,
      acceleration: sample.accelerationMps2,
      segment: sample.segment,
    })),
    [samples],
  );
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

      {!isDerivativeAnalysisActive && !isMainSpeedVisible && settings.floating.length > 0 && (
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
          key={sessionEndedAt ?? 'active'}
          samples={chartSamples}
          gaps={gaps}
          elapsed={elapsed}
          showSpeed={showSpeedInChart}
          showAcceleration={showAccelerationInChart}
          analysisAvailable={!isTracking && sessionEndedAt !== null}
          onAnalysisModeChange={setIsDerivativeAnalysisActive}
        />
        {gaps.length > 0 && (
          <p className="gap-note">
            {gaps.length === 1 ? '1 intervalo' : `${gaps.length} intervalos`} sin GPS ·{' '}
            {formatTime(gaps.reduce((total, gap) => total + gap.end - gap.start, 0))}
          </p>
        )}
      </section>

      <section className="session-card" aria-labelledby="session-title">
        <div className="session-heading">
          <div>
            <p>GUARDAR Y RECUPERAR</p>
            <h2 id="session-title">Sesión</h2>
          </div>
          <small>Archivo JSON versionado</small>
        </div>
        <p className="session-description">
          Conservá los puntos y el estado final para volver a ver esta medición tal cual terminó.
        </p>
        <div className="session-actions">
          <button
            className="session-button session-download"
            type="button"
            onClick={downloadSession}
            disabled={isTracking || sessionEndedAt === null || samples.length === 0}
          >
            Descargar sesión
          </button>
          <label className={`session-button session-load ${isTracking ? 'is-disabled' : ''}`}>
            Cargar archivo
            <input
              ref={sessionFileInput}
              type="file"
              accept="application/json,.json"
              disabled={isTracking}
              onChange={loadSession}
            />
          </label>
        </div>
        <p className="session-privacy">
          El archivo incluye coordenadas GPS precisas. Queda en tu dispositivo y VeloDelta no lo
          envía a ningún servidor.
        </p>
        {sessionNotice && (
          <p className="session-notice" role="status" aria-live="polite">{sessionNotice}</p>
        )}
        {sessionError && <p className="session-error" role="alert">{sessionError}</p>}
      </section>

      {!isDerivativeAnalysisActive && (
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
      )}

      <p className="safety-note">
        Mantené el teléfono seguro y no interactúes con la pantalla mientras estás en movimiento.
      </p>
    </main>
  );
}
