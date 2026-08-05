/** Stable error categories used by CLI hosts and automation. */
export type SmartUiErrorCode =
  | 'INVALID_INPUT'
  | 'POLICY_VIOLATION'
  | 'PROVIDER_FAILURE'
  | 'TIMEOUT'
  | 'NOT_FOUND';

export class SmartUiError extends Error {
  constructor(
    public readonly code: SmartUiErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'SmartUiError';
  }
}
