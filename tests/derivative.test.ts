import assert from 'node:assert/strict';
import test from 'node:test';

import {
  averageAccelerationMps2,
  derivativeConvergence,
  eligibleDerivativePointIndices,
  findAccelerationReferenceIndex,
  localTangentAccelerationMps2,
  tangentSpeedKmhAt,
  type DerivativeSample,
} from '../lib/derivative.ts';

const sample = (
  time: number,
  speedKmh: number,
  accelerationMps2: number | null = null,
  segment = 0,
): DerivativeSample => ({ time, speedKmh, accelerationMps2, segment });

test('averageAccelerationMps2 converts km/h to m/s before dividing by time', () => {
  assert.equal(
    averageAccelerationMps2(sample(8, 18), sample(10, 36)),
    2.5,
  );
});

test('averageAccelerationMps2 is independent of point order', () => {
  const from = sample(8, 18);
  const to = sample(10, 36);
  assert.equal(averageAccelerationMps2(from, to), averageAccelerationMps2(to, from));
});

test('averageAccelerationMps2 rejects zero time and GPS segment crossings', () => {
  assert.equal(averageAccelerationMps2(sample(1, 5), sample(1, 8)), null);
  assert.equal(averageAccelerationMps2(sample(1, 5, null, 0), sample(2, 8, null, 1)), null);
});

test('tangentSpeedKmhAt converts acceleration back to chart units', () => {
  assert.equal(tangentSpeedKmhAt(12, sample(10, 36), 2.5), 54);
});

test('localTangentAccelerationMps2 estimates a local slope from several samples', () => {
  const samples = [
    sample(0, 0),
    sample(1, 3.6),
    sample(2, 7.2),
    sample(3, 10.8),
    sample(4, 50),
  ];
  assert.ok(Math.abs((localTangentAccelerationMps2(samples, 2) ?? 0) - 1) < 1e-12);
});

test('localTangentAccelerationMps2 stays inside the selected GPS segment', () => {
  const samples = [
    sample(0, 0, null, 0),
    sample(1, 3.6, null, 0),
    sample(2, 7.2, 1, 0),
    sample(2, 100, null, 1),
  ];
  assert.equal(localTangentAccelerationMps2(samples, 2), 1);
});

test('findAccelerationReferenceIndex reconstructs the stored predecessor', () => {
  const samples = [
    sample(0, 0),
    sample(1, 3.6, 1),
    sample(2, 10.8, 2),
  ];
  assert.equal(findAccelerationReferenceIndex(samples, 2), 1);
  assert.deepEqual(eligibleDerivativePointIndices(samples), [1, 2]);
});

test('findAccelerationReferenceIndex never crosses a GPS segment', () => {
  const samples = [sample(0, 0, null, 0), sample(1, 3.6, 1, 1)];
  assert.equal(findAccelerationReferenceIndex(samples, 1), null);
});

test('derivativeConvergence requires both local proximity and displayed equality', () => {
  assert.equal(derivativeConvergence(0.864, 0.861, -0.5, 0.5), 'converged');
  assert.equal(derivativeConvergence(0.82, 0.86, -0.5, 0.5), 'approaching');
  assert.equal(derivativeConvergence(0.86, 0.86, -8, 0.5), 'far');
});
