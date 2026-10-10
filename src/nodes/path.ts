/**
 * Encode errors name where in the value they happened. Each container an
 * error passes on its way out prepends its own segment, so the message reads
 * from the root down (`filters[2].op: …`); the error keeps its class.
 */
const PATH = Symbol('polynar.path');

interface Located {
  [PATH]?: { segments: (string | number)[]; message: string };
}

const formatPath = (segments: readonly (string | number)[]): string =>
  segments
    .map((segment, i) =>
      typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`
    )
    .join('');

/** Prepend one container segment to an error thrown below it. */
export function atPath(error: unknown, segment: string | number): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const located = error as Error & Located;
  const info = (located[PATH] ??= { segments: [], message: error.message });
  info.segments.unshift(segment);
  const head = `${error.name}: ${error.message}`;
  error.message = `${formatPath(info.segments)}: ${info.message}`;
  // The stack captured the message when the error was built; its first line
  // follows the new one so an uncaught error prints the path too.
  if (error.stack?.startsWith(head)) {
    error.stack = `${error.name}: ${error.message}${error.stack.slice(head.length)}`;
  }
  return error;
}

/**
 * The allowed values in an error message: each one described while they are
 * few primitives, else their count, since an object prints as `[object Object]`.
 */
export const oneOf = (values: readonly unknown[]): string =>
  values.length <= 8 && values.every(isPrimitive)
    ? `one of ${values.map(describe).join(', ')}`
    : `one of the ${values.length} listed values`;

/**
 * A value as an error message shows it: as JSON, so a string is quoted and
 * `"5"` reads differently from `5`. Numbers, BigInts and invalid dates, which
 * JSON writes as `null` or refuses, and values JSON can't write show as text.
 */
export const describe = (value: unknown): string => {
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    (value instanceof Date && Number.isNaN(value.getTime()))
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const isPrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== 'object' && typeof value !== 'function');
