/**
 * Internal search-corpus contracts for checkJs.
 */

export interface CorpusDocument {
  id: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface CorpusInput {
  format?: string;
  version?: number;
  documents?: CorpusDocument[];
}

export interface LoadedCorpus {
  format: string;
  version: number;
  documents: CorpusDocument[];
}

export interface EvidenceHit {
  documentId?: string | null;
  field?: string | null;
  provenance?: string;
  type?: string;
  snippet?: string | null;
}

export interface CandidateEvidence {
  explicitDefinitions?: number;
  explicitMentions?: number;
  titleCooccurrences?: number;
  bodyCooccurrences?: number;
  titleOccurrencesOfKey?: number;
  titleKeyBodyPhrase?: number;
  expansionDf?: number;
  keyDf?: number;
  withinDocumentRepeats?: number;
  supportingDocuments?: number;
  provenances?: string[];
  dfA?: number;
  dfB?: number;
  titleDfA?: number;
  titleDfB?: number;
  explicitAlias?: number;
  fromEquivalence?: string;
  manualSeed?: unknown;
}

export type EquivalenceEvidence = CandidateEvidence;
export type SynonymEvidence = CandidateEvidence;

export interface ReviewContribution {
  name: string;
  weight: number;
}

export type LifecycleState =
  | "AUTO_ACCEPTED"
  | "REVIEW_PENDING"
  | "HUMAN_ACCEPTED"
  | "HUMAN_REJECTED"
  | "CONFLICT"
  | "ORPHANED_DECISION"
  | "COMPILER_REJECTED"
  | string;

export type ReviewBand = "HIGH" | "MEDIUM" | "LOW" | string;

export interface EquivalenceCandidate {
  type?: string;
  id?: string;
  key: string;
  expansion: string[];
  expansionPhrase?: string;
  aliases?: unknown[];
  primary?: string | null;
  standaloneRecall?: string[];
  topicalRecall?: string[][];
  terms?: string[];
  relation?: string;
  initialsMatch?: boolean;
  hits?: EvidenceHit[];
  evidence?: CandidateEvidence;
  reasons?: string[];
  provenance?: EvidenceHit[];
  status?: string;
  decision?: string;
  compilerStatus?: string;
  compilerDecision?: string;
  recommendation?: string;
  lifecycle?: LifecycleState;
  flags?: string[];
  override?: string;
  decisionRecord?: EquivalenceDecision | null;
  familyId?: string;
  familyRole?: string;
  canonicalId?: string;
  reviewBand?: ReviewBand | null;
  reviewScore?: number | null;
  reviewContributions?: ReviewContribution[];
  morphologyRedundant?: boolean;
}

export interface SynonymCandidate {
  type?: string;
  id?: string;
  terms: string[];
  relation?: string;
  key?: string;
  expansion?: string[];
  expansionPhrase?: string;
  initialsMatch?: boolean;
  status?: string;
  decision?: string;
  compilerStatus?: string;
  compilerDecision?: string;
  recommendation?: string;
  lifecycle?: LifecycleState;
  morphologyRedundant?: boolean;
  evidence?: CandidateEvidence;
  provenance?: EvidenceHit[];
  reasons?: string[];
  flags?: string[];
  override?: string;
  decisionRecord?: SynonymDecision | null;
  familyId?: string;
  familyRole?: string;
  canonicalId?: string;
  reviewBand?: ReviewBand | null;
  reviewScore?: number | null;
  reviewContributions?: ReviewContribution[];
}

export type CorpusCandidate = EquivalenceCandidate | SynonymCandidate;

export interface EquivalenceDecision {
  id: string;
  type: string;
  decision: string;
  key: string;
  expansion: string[];
  expansionPhrase: string;
  aliases: unknown[];
  manual: boolean;
  primary?: string | null;
  provenance?: string | null;
}

export interface SynonymDecision {
  id: string;
  type: string;
  decision: string;
  terms: string[];
  relation: string;
  manual: boolean;
  directional: boolean;
}

export interface DecisionDoc {
  format: string;
  version: number;
  equivalences: EquivalenceDecision[];
  synonyms: SynonymDecision[];
}

export interface DecisionOverrides {
  accept?: Array<{ key?: unknown; expansion?: unknown; aliases?: unknown; primary?: unknown }>;
  reject?: Array<{ key?: unknown; expansion?: unknown; aliases?: unknown }>;
  add?: Array<{ key?: unknown; expansion?: unknown; aliases?: unknown; primary?: unknown }>;
}

/** @deprecated Use DecisionOverrides. */
export type Phase6Overrides = DecisionOverrides;

export interface DecisionIndex {
  loaded: DecisionDoc;
  eqById: Map<string, EquivalenceDecision>;
  eqRejectKeys: Set<string>;
  eqByKey: Map<string, EquivalenceDecision[]>;
  synById: Map<string, SynonymDecision>;
}

export interface LifecycleResult {
  equivalences: EquivalenceCandidate[];
  synonyms: SynonymCandidate[];
  conflicts: Array<Record<string, unknown>>;
  flags: Array<Record<string, unknown>>;
  orphaned: CorpusCandidate[];
}

export interface InspectionDelta {
  summary?: Record<string, number>;
  newReview?: string[];
  existingUnresolved?: string[];
  evidenceChanged?: string[];
  supportOnlyChanges?: string[];
  newHigh?: string[];
  newMedium?: string[];
  newLow?: string[];
  promoted?: string[];
  demoted?: string[];
  newConflicts?: string[];
  orphanedDecisions?: string[];
  [key: string]: unknown;
}

export interface ReviewerRow {
  id?: string;
  type?: string;
  key?: unknown;
  expansion?: unknown;
  expansionPhrase?: unknown;
  aliases?: unknown;
  primary?: string | null;
  terms?: unknown;
  relation?: unknown;
  compilerStatus?: string;
  compilerDecision?: string;
  recommendation?: string;
  lifecycle?: LifecycleState;
  initialsMatch?: boolean;
  evidence?: CandidateEvidence;
  examples?: EvidenceHit[];
  reasons?: string[];
  flags?: string[];
  familyId?: string | null;
  familyRole?: string | null;
  canonicalId?: string | null;
  reviewBand?: ReviewBand | null;
  reviewScore?: number | null;
  reviewContributions?: ReviewContribution[];
  decisionSkeleton?: unknown;
  decisionRecord?: unknown;
}

export interface InspectionDoc {
  format: string;
  version: number;
  accepted: EquivalenceCandidate[];
  review: EquivalenceCandidate[];
  rejected: EquivalenceCandidate[];
  synonymCandidates: SynonymCandidate[];
  candidates: ReviewerRow[];
  lifecycle: Record<string, ReviewerRow[]>;
  pending: ReviewerRow[];
  synonymPending: ReviewerRow[];
  reviewQueue: ReviewerRow[];
  families: unknown[];
  queueStats: unknown;
  conflicts: unknown[];
  flags: unknown[];
  orphaned: ReviewerRow[];
  delta: InspectionDelta | null;
  counts: Record<string, number>;
}

export interface EquivalenceArtifact {
  format: "search-v2-equivalences";
  version: 1;
  entries: Array<{
    key: string;
    aliases: string[][];
    type: string;
    provenance: string;
    confidence: null;
    reasons: string[];
  }>;
  compileWarnings: Array<{ key: string; reason: string; ids: unknown[] }>;
}

export type GeneratedRelationshipMap = Record<
  string,
  Array<{ to: { form: string }; kind: "equivalent" }>
>;

export interface VocabularyTerm {
  term: string;
  tf: number;
  df: number;
  titleDf: number;
  kind: string;
  spellingTrusted: boolean;
  surfaces: string[];
}

export interface VocabularyArtifact {
  format: string;
  version: number;
  terms: VocabularyTerm[];
}

export interface AnalyzeOptions {
  decisions?: unknown;
  overrides?: unknown;
  previousInspection?: InspectionDoc | null;
}

export interface CompileOptions {
  overrides?: unknown;
  decisions?: unknown;
  previousInspection?: InspectionDoc | null;
}

export interface AnalyzeResult {
  documents: number;
  documentRecords: CorpusDocument[];
  decisionDoc: DecisionDoc;
  classified: EquivalenceCandidate[];
  inspection: InspectionDoc;
  timings: Record<string, number>;
  corpusHash: string;
  decisionsHash: string;
  life: LifecycleResult;
}

export interface IndexedDocument {
  id: string;
  title: string[];
  body: string[];
  titleSet: Set<string>;
  allSet: Set<string>;
  titleAcronymKeys: Set<string>;
  allAcronymKeys: Set<string>;
  titleAcronymKeyList?: string[];
  bodyAcronymKeyList?: string[];
  titleJoined: string;
  allJoined: string;
}
