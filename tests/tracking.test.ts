import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clamp,
  formatDistance,
  formatTime,
  haversineMeters,
  type Reading,
} from '../lib/tracking.ts';

const reading = (
  latitude: number,
  longitude: number,
  accuracy = 5,
  timestamp = 0,
): Reading => ({ latitude, longitude, accuracy, timestamp });

test('haversineMeters returns zero for the same point', () => {
  const point = reading(0, 0);
  assert.equal(haversineMeters(point, point), 0);
});

test('haversineMeters measures one degree at the equator', () => {
  const distance = haversineMeters(reading(0, 0), reading(0, 1));
  assert.ok(distance > 111_000 && distance < 111_300);
});

test('haversineMeters is symmetrical', () => {
  const from = reading(10, 20);
  const to = reading(10.01, 20.01);
  assert.equal(haversineMeters(from, to), haversineMeters(to, from));
});

test('formatTime formats durations below one hour', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(65.9), '01:05');
  assert.equal(formatTime(3599), '59:59');
});

test('formatTime includes hours when needed', () => {
  assert.equal(formatTime(3661), '01:01:01');
});

test('formatDistance uses metres below one kilometre', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(999.4), '999 m');
});

test('formatDistance uses kilometres from one kilometre', () => {
  assert.equal(formatDistance(1000), '1.00 km');
  assert.equal(formatDistance(1234), '1.23 km');
});

test('clamp keeps values inside the requested interval', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(11, 0, 10), 10);
});
