export class EnrichmentError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "EnrichmentError";
    this.details = details;
  }
}
