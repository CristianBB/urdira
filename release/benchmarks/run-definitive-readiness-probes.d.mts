export interface ReadinessQuery {
  readonly request_type: "query";
  readonly query: {
    readonly scope: { readonly scope_type: "single_workspace"; readonly workspace_id: string };
    readonly expression: { readonly expression_type: "operation"; readonly operation: "core:search_text"; readonly arguments: Record<string, unknown> };
    readonly options: { readonly freshness: "current"; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  };
}

export interface BlockedWarmProbe {
  readonly workspace_id: string | null;
  readonly passed: false;
  readonly failure: string;
  readonly timestamps: Record<string, number | null>;
  readonly [key: string]: unknown;
}

export function buildReadinessQuery(workspaceId: string): ReadinessQuery;
export function blockedWarmProbe(input: { readonly workspace_id?: string | null; readonly failure?: string | null }): BlockedWarmProbe;
export function runReadinessPhase(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function executeReadinessPair(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runReadinessCampaign(options: Record<string, unknown>): Promise<Record<string, unknown>>;
