import type { AuthAccountQuery, CredentialAuthentication } from "../interfaces";

export type AuthControllerDeps = {
  credentials: CredentialAuthentication;
  accounts: AuthAccountQuery;
};
