/**
 * Creates an admin user, or promotes an existing user to admin.
 *
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='...' npm run create-admin
 *
 * Admins are never created through the public API.
 */
import 'reflect-metadata';
import dataSource from '../database/data-source.js';
import { hashPassword } from '../auth/password.js';
import { User, UserRole } from '../users/user.entity.js';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error(
      'Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters)',
    );
  }

  await dataSource.initialize();
  try {
    const users = dataSource.getRepository(User);
    const existing = await users.findOneBy({ email });
    if (existing) {
      existing.role = UserRole.ADMIN;
      existing.passwordHash = await hashPassword(password);
      await users.save(existing);
      console.log(`Promoted ${email} to ADMIN and reset the password`);
    } else {
      await users.save(
        users.create({
          email,
          passwordHash: await hashPassword(password),
          role: UserRole.ADMIN,
        }),
      );
      console.log(`Created admin ${email}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
