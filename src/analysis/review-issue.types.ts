export type ReviewCriticality = 'low' | 'medium' | 'high';
export type ReviewIssueBaselineStatus = 'new' | 'persistent' | 'known_debt';

export interface ReviewIssueEvidence {
  file: string;
  quote: string;
}

export interface ReviewIssue {
  file: string;
  snippet: string;
  description: string;
  reason: string;
  criticality: ReviewCriticality;
  rule: string;
  evidence?: ReviewIssueEvidence;
  issueKey?: string;
  baselineStatus?: ReviewIssueBaselineStatus;
  advisory?: boolean;
}

export interface GeneralIssue {
  file: string;
  snippet: string;
  description: string;
  reason: string;
  criticality: ReviewCriticality;
  issueKey: string;
}
