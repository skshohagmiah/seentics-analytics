import type { UserRepository, UserRow } from "../interfaces/user-repository.interface";

/** Account reads used by setup status and the authenticated `/me` endpoint. */
export class AuthAccountQueryService {
  constructor(private readonly users: UserRepository) {}

  countUsers(): Promise<number> {
    return this.users.countAll();
  }

  getById(userId: string): Promise<UserRow | null> {
    return this.users.findById(userId);
  }
}
