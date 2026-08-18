/**
 * Public Search V2 errors. Keep the set small and actionable.
 * AbortError is created in cancel.js (DOMException when available).
 */

export class InvalidConfigurationError extends Error {
  /**
   * @param {string} message
   * @param {{ field?: string | null, expected?: string | null }} [info]
   */
  constructor(message, { field, expected } = {}) {
    super(message);
    this.name = "InvalidConfigurationError";
    this.field = field || null;
    this.expected = expected || null;
  }
}

export class InvalidDocumentError extends Error {
  /**
   * @param {string} message
   * @param {{ index?: number | null, field?: string | null }} [info]
   */
  constructor(message, { index, field } = {}) {
    super(message);
    this.name = "InvalidDocumentError";
    this.index = index == null ? null : index;
    this.field = field || null;
  }
}

export class ArtifactVersionError extends Error {
  /**
   * @param {string} message
   * @param {{ format?: string | null, version?: number | null }} [info]
   */
  constructor(message, { format, version } = {}) {
    super(message);
    this.name = "ArtifactVersionError";
    this.format = format || null;
    this.version = version == null ? null : version;
  }
}

export class ArtifactValidationError extends Error {
  /**
   * @param {string} message
   * @param {{ format?: string | null, field?: string | null }} [info]
   */
  constructor(message, { format, field } = {}) {
    super(message);
    this.name = "ArtifactValidationError";
    this.format = format || null;
    this.field = field || null;
  }
}

export class IndexStateError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message);
    this.name = "IndexStateError";
  }
}
