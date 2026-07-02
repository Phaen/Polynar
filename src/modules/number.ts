/**
 * Number encoding module
 */

import { registerModule } from './registry';

export function registerNumberModule() {
  // (value - min) / step is the bucket index, but floating-point division can
  // miss the exact integer by a few ULP (e.g. 0.3 / 0.1 === 2.9999999999999996).
  // Snap to the nearest integer when within a small tolerance. Return NaN to
  // signal a genuinely step-misaligned value.
  const STEP_TOLERANCE = 1e-9;
  const bucketIndex = (value: number): number => {
    const rounded = Math.round(value);
    // A small absolute slack absorbs typical division noise. For large bucket
    // indices it grows with magnitude (a few ULP) so legitimately-aligned values
    // still snap, but never far enough that a genuinely off-step value (~0.5
    // away) is silently rounded into a neighbouring bucket.
    const tolerance = Math.max(STEP_TOLERANCE, 8 * Number.EPSILON * Math.abs(rounded));
    return Math.abs(value - rounded) <= tolerance ? rounded : NaN;
  };
  // Count of representable values in a bounded [min, max] range at the given
  // step. Rounded so the radix is an exact integer on both encode and decode.
  const rangeSize = (options: any): number =>
    Math.round((options.max - options.min) / options.step) + 1;

  // Smallest number of decimal places at which x is represented exactly, or
  // null when there is none within double precision (e.g. 1/3, Math.PI).
  const decimalPlaces = (x: number): number | null => {
    let e = 1;
    for (let p = 0; p <= 15; p++, e *= 10) {
      if (Math.round(x * e) / e === x) {
        return p;
      }
    }
    return null;
  };

  // Decoded values sit on the grid `offset + idx * step`, but computing that
  // directly in floats drifts (1314 * 0.01 - 10 → 3.1400000000000006). When
  // step and offset are short decimals, work in decimal-scaled integers and
  // divide back once, so grid values decode exactly.
  const gridValue = (idx: number, step: number, offset: number): number => {
    const stepPlaces = decimalPlaces(step);
    const offsetPlaces = decimalPlaces(offset);

    if (stepPlaces !== null && offsetPlaces !== null) {
      const scale = Math.pow(10, Math.max(stepPlaces, offsetPlaces));
      const scaled = idx * Math.round(step * scale) + Math.round(offset * scale);

      if (Math.abs(scaled) <= Number.MAX_SAFE_INTEGER) {
        return scaled / scale;
      }
    }

    return idx * step + offset;
  };

  registerModule(
    'number',
    function (options) {
      if (options.step == null) {
        options.step = 1;
      } else if (typeof options.step !== 'number' || !(options.step > 0)) {
        // Step is a divisor. 0/negative/NaN have no meaning and step 0 would
        // divide by zero into an infinite encode loop.
        throw new TypeError('Invalid step size');
      }

      if (options.min == null) options.min = 0;
      if (options.max == null) options.max = 0;

      if (
        (typeof options.min !== 'number' &&
          typeof options.min !== 'boolean' &&
          options.min !== false) ||
        (typeof options.max !== 'number' &&
          typeof options.max !== 'boolean' &&
          options.max !== false)
      ) {
        throw new TypeError('Invalid range bound');
      }

      if (options.max !== false && options.min !== false) {
        if (options.min > options.max) {
          [options.min, options.max] = [options.max, options.min];
        }

        if (Number.isNaN(bucketIndex((options.max - options.min) / options.step))) {
          throw new TypeError('Range bound outside step range');
        }
      }
    },
    function (items, options) {
      // min/max being false is constant across the batch, so the bounded radix
      // is computed once rather than per item.
      const bounded = options.max !== false && options.min !== false;
      const size = bounded ? rangeSize(options) : 0;

      for (const i in items) {
        const item = items[i];

        if (typeof item !== 'number') {
          throw new TypeError(`Item '${item}' not a number`);
        }

        if (options.max === false || options.min === false) {
          let sign = 0;
          let value = item;

          if (options.min === false && options.max === false) {
            if (value < 0) sign++;
            value = Math.abs(value);
          } else if (options.min === false) {
            value = -1 * value + options.max;
          } else {
            value -= options.min;
          }

          if (value < 0) {
            throw new RangeError(`Item '${item}' exceeds range bounds`);
          }

          const idx = bucketIndex(value / options.step);

          if (Number.isNaN(idx)) {
            throw new RangeError(`Item '${item}' outside step range`);
          }

          this.composeTerm(idx);

          if (options.min === false && options.max === false) {
            this.compose(sign, 2);
          }
        } else {
          if (item < options.min || item > options.max) {
            throw new RangeError(`Item '${item}' exceeds range bounds`);
          }

          const idx = bucketIndex((item - options.min) / options.step);

          if (Number.isNaN(idx)) {
            throw new RangeError(`Item '${item}' outside step range`);
          }

          this.compose(idx, size);
        }
      }
    },
    function (options, count) {
      const items: number[] = [];
      if (options.max === false || options.min === false) {
        for (let i = 0; i < count; i++) {
          const idx = this.parseTerm();
          let item: number;

          if (options.max === false && options.min === false) {
            item = gridValue(idx, options.step, 0);
            if (this.parse(2)) item *= -1;
          } else if (options.max === false) {
            item = gridValue(idx, options.step, options.min);
          } else {
            item = gridValue(-idx, options.step, options.max);
          }

          items.push(item);
        }
      } else {
        const size = rangeSize(options);
        for (let i = 0; i < count; i++) {
          items.push(gridValue(this.parse(size), options.step, options.min));
        }
      }
      return items;
    }
  );
}
