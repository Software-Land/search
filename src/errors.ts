/**
 * Public search errors. Keep the set small and actionable.
 * AbortError is created in cancel.js (DOMException when available).
 */

export class InvalidConfigurationError extends Error {
  declare field: string | null;
  declare expected: string | null;

  constructor(message: string, { field, expected }: { field?: string | null; expected?: string | null } = {}) {
    super(message);
    this.name = "InvalidConfigurationError";
    this.field = field || null;
    this.expected = expected || null;
  }
}

export class InvalidDocumentError extends Error {
  declare index: number | null;
  declare field: string | null;

  constructor(message: string, { index, field }: { index?: number | null; field?: string | null } = {}) {
    super(message);
    this.name = "InvalidDocumentError";
    this.index = index == null ? null : index;
    this.field = field || null;
  }
}

export class ArtifactVersionError extends Error {
  declare format: string | null;
  declare version: number | null;

  constructor(message: string, { format, version }: { format?: string | null; version?: number | null } = {}) {
    super(message);
    this.name = "ArtifactVersionError";
    this.format = format || null;
    this.version = version == null ? null : version;
  }
}

export class ArtifactValidationError extends Error {
  declare format: string | null;
  declare field: string | null;

  constructor(message: string, { format, field }: { format?: string | null; field?: string | null } = {}) {
    super(message);
    this.name = "ArtifactValidationError";
    this.format = format || null;
    this.field = field || null;
  }
}

export class IndexStateError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "IndexStateError";
  }
}
