export type DerivativeSample = {
  time: number;
  speedKmh: number;
  accelerationMps2: number | null;
  segment: number;
};

export type DerivativeConvergence = 'far' | 'approaching' | 'converged';

const REFERENCE_MATCH_TOLERANCE = 1e-7;

export function averageAccelerationMps2(
  from: DerivativeSample,
  to: DerivativeSample,
) {
  if (from.segment !== to.segment) return null;
  const deltaSeconds = to.time - from.time;
  if (!Number.isFinite(deltaSeconds) || Math.abs(deltaSeconds) < Number.EPSILON) {
    return null;
  }

  const deltaMetersPerSecond = (to.speedKmh - from.speedKmh) / 3.6;
  const acceleration = deltaMetersPerSecond / deltaSeconds;
  return Number.isFinite(acceleration) ? acceleration : null;
}

export function tangentSpeedKmhAt(
  time: number,
  point: DerivativeSample,
  accelerationMps2: number,
) {
  return point.speedKmh + (time - point.time) * accelerationMps2 * 3.6;
}

export function findAccelerationReferenceIndex(
  samples: DerivativeSample[],
  pointIndex: number,
) {
  const point = samples[pointIndex];
  if (!point || point.accelerationMps2 === null) return null;

  for (let index = pointIndex - 1; index >= 0; index -= 1) {
    const candidate = samples[index];
    if (candidate.segment !== point.segment) break;

    const deltaSeconds = point.time - candidate.time;
    if (deltaSeconds > 15) break;
    if (deltaSeconds < 0.25) continue;

    const acceleration = averageAccelerationMps2(candidate, point);
    if (
      acceleration !== null &&
      Math.abs(acceleration - point.accelerationMps2) <= REFERENCE_MATCH_TOLERANCE
    ) {
      return index;
    }
  }

  return null;
}

export function eligibleDerivativePointIndices(samples: DerivativeSample[]) {
  return samples.flatMap((_, index) =>
    findAccelerationReferenceIndex(samples, index) === null ? [] : [index],
  );
}

export function derivativeConvergence(
  averageAcceleration: number | null,
  pointAcceleration: number | null,
  deltaSeconds: number,
  referenceDeltaSeconds: number,
): DerivativeConvergence {
  if (
    averageAcceleration === null ||
    pointAcceleration === null ||
    !Number.isFinite(deltaSeconds) ||
    !Number.isFinite(referenceDeltaSeconds)
  ) {
    return 'far';
  }

  const localWindowSeconds = Math.max(3, Math.abs(referenceDeltaSeconds) * 4);
  if (Math.abs(deltaSeconds) > localWindowSeconds) return 'far';

  return averageAcceleration.toFixed(2) === pointAcceleration.toFixed(2)
    ? 'converged'
    : 'approaching';
}
