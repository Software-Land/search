/**
 * Minimal platform types for Search Core.
 * Core is not a DOM or Worker environment; these exist in Node 18+ and browsers.
 * Do not add window, document, or Worker here.
 */

interface AbortSignal {
  readonly aborted: boolean;
  addEventListener?(type: string, listener: () => void, options?: { once?: boolean }): void;
}

interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare var AbortController: {
  prototype: AbortController;
  new (reason?: unknown): AbortController;
};

interface Performance {
  now(): number;
}

declare var performance: Performance;

interface DOMException extends Error {
  readonly name: string;
  readonly message: string;
  readonly code?: number;
}

declare var DOMException: {
  prototype: DOMException;
  new (message?: string, name?: string): DOMException;
};
