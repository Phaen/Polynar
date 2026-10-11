/**
 * Encode errors name where in the value they happened. Each container an
 * error passes on its way out prepends its own segment, so the message reads
 * from the root down (`filters[2].op: …`); the error keeps its class.
 */
const PATH = Symbol('polynar.path');

interface Located {
  // null marks an error whose message stays as thrown.
  [PATH]?: { segments: (string | number)[]; message: string } | null;
}

export const formatPath = (segments: readonly (string | number)[]): string =>
  segments
    .map((segment, i) =>
      typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`
    )
    .join('');

/**
 * Marks an error so containers leave its message as thrown: for an error
 * whose path says nothing, such as a nesting limit, where the path only
 * spells out the limit one segment per level.
 */
export function unlocated<E extends Error>(error: E): E {
  (error as E & Located)[PATH] = null;
  return error;
}

/** Prepend one container segment to an error thrown below it. */
export function atPath(error: unknown, segment: string | number): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const located = error as Error & Located;
  if (located[PATH] === null) {
    return error;
  }
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
 * one to eight primitives, else their count, since an object prints as
 * `[object Object]`.
 */
export const oneOf = (values: readonly unknown[]): string =>
  values.length > 0 && values.length <= 8 && values.every(isPrimitive)
    ? `one of ${values.map(describe).join(', ')}`
    : `one of the ${values.length} listed values`;

/**
 * A value as an error message shows it: as JSON, so a string is quoted and
 * `"5"` reads differently from `5`. Numbers and invalid dates, which JSON
 * writes as `null`, show as text, a BigInt with its `n`, and anything JSON
 * can't write as text. Long renderings are cut short.
 */
export const describe = (value: unknown): string => {
  let text: string;
  if (typeof value === 'number' || (value instanceof Date && Number.isNaN(value.getTime()))) {
    text = String(value);
  } else if (typeof value === 'bigint') {
    text = `${value}n`;
  } else {
    // A cycle, a nested BigInt or a throwing toJSON or toString leaves the
    // value's tag, as in `[object Object]`.
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = Object.prototype.toString.call(value);
    }
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

const isPrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== 'object' && typeof value !== 'function');
