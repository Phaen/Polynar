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
