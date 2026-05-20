/**
 * Domain error hierarchy. Each subclass carries an MCP error code that
 * withErrorHandling maps onto the wire response, so MCP clients can branch
 * on `code` programmatically instead of parsing message text.
 */
export class DomainError extends Error {
  public readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Resource was not located: missing breakpoint, frame, variable, target, etc. */
export class NotFoundError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'NOT_FOUND', options);
  }
}

/** Caller-supplied argument was invalid or unsupported. */
export class ValidationError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'INVALID_ARGUMENT', options);
  }
}

/** No active debug session / transport when one is required. */
export class NotConnectedError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'NOT_CONNECTED', options);
  }
}

/** A DAP or CDP request failed at the protocol layer. */
export class ProtocolError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PROTOCOL_ERROR', options);
  }
}
