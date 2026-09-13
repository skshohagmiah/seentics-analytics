import type { LoginUserInput, RegisterUserInput } from "../../../platform/lib/api-types";
import type { FrontendUser } from "./auth.interface";
import type { UserRow } from "./user-repository.interface";

export type AuthTokens = { access_token: string; refresh_token: string };
export type AuthResult = { data: { user: FrontendUser; tokens: AuthTokens } };

export interface CredentialAuthentication {
  register(input: RegisterUserInput): Promise<AuthResult>;
  login(input: LoginUserInput): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<AuthTokens>;
}

export interface AuthAccountQuery {
  countUsers(): Promise<number>;
  getById(userId: string): Promise<UserRow | null>;
}
