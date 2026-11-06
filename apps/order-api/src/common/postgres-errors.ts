import { QueryFailedError } from 'typeorm';

const UNIQUE_VIOLATION = '23505';

/** True if the error is a PostgreSQL unique-constraint violation (optionally a specific one). */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as {
    code?: string;
    constraint?: string;
  };
  if (driverError?.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || driverError.constraint === constraint;
}
