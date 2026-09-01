import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionFile,
  parseSession,
  parseSessionJson,
  serializeSession,
  VELODELTA_SESSION_FORMAT,
  VELODELTA_SESSION_VERSION,
  type SessionSnapshot,
} from '../lib/session.ts';

const snapshot: SessionSnapshot = {
  startedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5),
  endedAtMs: Date.UTC(2026, 0, 2, 3, 4, 17),
  finalState: {
    elapsedSeconds: 12.25,
    distanceMeters: 24.5,
    speedKmh: 0,
    accelerationMps2: 0,
  },
  points: [
    {
      timestampMs: Date.UTC(2026, 0, 2, 3, 4, 5),
      elapsedSeconds: 0,
      latitude: 0,
      longitude: 0,
      accuracyMeters: 5,
      reportedSpeedMps: 2,
      speedKmh: 7.2,
      accelerationMps2: null,
      distanceMeters: 0,
      segment: 0,
    },
    {
      timestampMs: Date.UTC(2026, 0, 2, 3, 4, 15),
      elapsedSeconds: 10,
      latitude: 0,
      longitude: 0.0002,
      accuracyMeters: 5,
      reportedSpeedMps: 2.2,
      speedKmh: 7.92,
      accelerationMps2: 0.02,
      distanceMeters: 24.5,
      segment: 1,
    },
  ],
  gaps: [{ startSeconds: 4, endSeconds: 9 }],
  settings: {
    chart: ['speed', 'acceleration'],
    floating: ['time', 'distance'],
  },
};

test('serializeSession preserves every value needed to reconstruct the final state', () => {
  const json = serializeSession(snapshot, Date.UTC(2026, 0, 2, 3, 5));
  const restored = parseSessionJson(json);

  assert.deepEqual(restored, snapshot);
  const encoded = JSON.parse(json);
  assert.equal(encoded.format, VELODELTA_SESSION_FORMAT);
  assert.equal(encoded.version, VELODELTA_SESSION_VERSION);
});

test('parseSession rejects files from an unsupported version', () => {
  const file = createSessionFile(snapshot);

  assert.throws(
    () => parseSession({ ...file, version: 2 }),
    /versión del archivo no es compatible/,
  );
});

test('parseSession rejects points outside the valid coordinate range', () => {
  const file = createSessionFile(snapshot);
  file.session.points[0] = { ...file.session.points[0], latitude: 91 };

  assert.throws(() => parseSession(file), /coordenadas fuera de rango/);
});

test('parseSession rejects points that are not chronological', () => {
  const file = createSessionFile(snapshot);
  file.session.points[1] = { ...file.session.points[1], elapsedSeconds: 0 };
  file.session.points[0] = { ...file.session.points[0], elapsedSeconds: 1 };

  assert.throws(() => parseSession(file), /no están ordenados cronológicamente/);
});

test('parseSessionJson reports malformed JSON', () => {
  assert.throws(() => parseSessionJson('{'), /JSON válido/);
});
