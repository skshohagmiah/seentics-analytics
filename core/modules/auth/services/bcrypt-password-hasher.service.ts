import bcrypt from "bcryptjs";
import type { PasswordHasher } from "../interfaces/password-hasher.interface";

/** Bcrypt work factor. Raising it invalidates nothing because the hash stores the cost. */
const COST = 12;

export class BcryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST);
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plain, hash);
    } catch {
      // A stored hash that bcrypt cannot parse is a failed check, not an error page.
      return false;
    }
  }
}
