/** What a verified MCP bearer token yields. Only the gateway's verifier produces these. */
export interface AuthenticatedIdentity {
  subject: string;
  scopes: Set<string>;
  /** The token's client_id claim (gateway tokens always carry one); keys the alerts delivery ledger. */
  clientId?: string;
  authorizedParty?: string;
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super("Invalid access token");
    this.name = "InvalidAccessTokenError";
  }
}

export class MissingRequiredScopeError extends Error {
  constructor(readonly scope: string) {
    super(`Missing required scope: ${scope}`);
    this.name = "MissingRequiredScopeError";
  }
}
