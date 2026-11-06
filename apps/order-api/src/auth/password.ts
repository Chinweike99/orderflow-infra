import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * A real hash of a random string. Comparing against it when a user does not
 * exist makes failed logins take the same time whether or not the email is
 * registered, so response times don't reveal which emails have accounts.
 */
export const DUMMY_PASSWORD_HASH =
  '$2b$12$Q8inVAnt1Mvi1BmEI1Lmg.bKCGLPygA1XpS1Ahu.53OpuJTSzrhcS';
