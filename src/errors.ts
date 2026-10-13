/**
 * The text of whatever was thrown: a catch clause gives `unknown`, and not everything thrown is an Error. A caller that
 * must not log arbitrary thrown values (they may carry a credential) passes `fallback` to say something fixed instead.
 */
export const errorMessage = (error: unknown, fallback?: string): string =>
  error instanceof Error ? error.message : (fallback ?? String(error))
