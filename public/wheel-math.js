export const normalizeAngle = value => ((Number(value) % 360) + 360) % 360;

export function segmentCenter(index, count) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) throw new Error('invalid wheel segment');
  return -90 + (index + 0.5) * (360 / count);
}

export function landingDelta(currentOffset, index, count) {
  return normalizeAngle(-90 - (segmentCenter(index, count) + normalizeAngle(currentOffset)));
}

export function landingRotation(currentOffset, index, count, turns = 5) {
  return Math.max(1, Number(turns) || 1) * 360 + landingDelta(currentOffset, index, count);
}

export function settledOffset(currentOffset, index, count) {
  return normalizeAngle(normalizeAngle(currentOffset) + landingDelta(currentOffset, index, count));
}
