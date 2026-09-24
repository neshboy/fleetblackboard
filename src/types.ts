export interface Claim {
  id: string;
  subject: string;
  value: string;
  normalizedValue: string;
  file: string | null;
  confidence: number;
  agent: string;
  createdAt: string;
}

export interface Conflict {
  id: string;
  subject: string;
  priorClaimId: string;
  newClaimId: string;
  createdAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedClaimId: string | null;
  resolutionNote: string | null;
}

export interface ConflictWithClaims extends Conflict {
  priorClaim: Claim;
  newClaim: Claim;
}

export interface RecordClaimInput {
  subject: string;
  value: string;
  file?: string | null;
  confidence?: number;
  agent?: string;
}

export interface RecordClaimResult {
  claim: Claim;
  conflict: ConflictWithClaims | null;
}
