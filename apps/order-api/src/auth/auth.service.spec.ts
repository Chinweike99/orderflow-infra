import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { QueryFailedError } from 'typeorm';
import { UserRole, type User } from '../users/user.entity.js';
import type { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    passwordHash: '',
    role: UserRole.CUSTOMER,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('AuthService', () => {
  let users: {
    findByEmail: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let jwt: { signAsync: ReturnType<typeof vi.fn> };
  let service: AuthService;

  beforeEach(() => {
    users = { findByEmail: vi.fn(), findById: vi.fn(), create: vi.fn() };
    jwt = { signAsync: vi.fn().mockResolvedValue('signed-token') };
    service = new AuthService(
      users as unknown as UsersService,
      jwt as unknown as JwtService,
    );
  });

  describe('register', () => {
    it('creates a customer with a hashed password and never returns the hash', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockImplementation(
        async (email: string, passwordHash: string) =>
          makeUser({ email, passwordHash }),
      );

      const result = await service.register('ada@example.com', 'correct-horse');

      const storedHash = users.create.mock.calls[0][1] as string;
      expect(storedHash).not.toBe('correct-horse');
      expect(storedHash).toMatch(/^\$2[aby]\$12\$/);
      expect(result).toEqual({
        id: 'user-1',
        email: 'ada@example.com',
        role: UserRole.CUSTOMER,
        createdAt: new Date('2026-01-01'),
      });
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('rejects an email that is already registered', async () => {
      users.findByEmail.mockResolvedValue(makeUser());
      await expect(
        service.register('ada@example.com', 'correct-horse'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a race on the unique email constraint to 409', async () => {
      users.findByEmail.mockResolvedValue(null);
      users.create.mockRejectedValue(
        new QueryFailedError(
          'INSERT',
          [],
          Object.assign(new Error('dup'), { code: '23505' }),
        ),
      );
      await expect(
        service.register('ada@example.com', 'correct-horse'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('login', () => {
    it('returns a bearer token for valid credentials', async () => {
      users.findByEmail.mockResolvedValue(
        makeUser({ passwordHash: await hashPassword('correct-horse') }),
      );

      const result = await service.login(
        'ada@example.com',
        'correct-horse',
        3600,
      );

      expect(result).toEqual({
        accessToken: 'signed-token',
        tokenType: 'Bearer',
        expiresIn: 3600,
      });
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        email: 'ada@example.com',
        role: UserRole.CUSTOMER,
      });
    });

    it('rejects a wrong password', async () => {
      users.findByEmail.mockResolvedValue(
        makeUser({ passwordHash: await hashPassword('correct-horse') }),
      );
      await expect(
        service.login('ada@example.com', 'wrong', 3600),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an unknown email with the same error', async () => {
      users.findByEmail.mockResolvedValue(null);
      await expect(
        service.login('nobody@example.com', 'x', 3600),
      ).rejects.toThrow('Invalid email or password');
    });
  });
});
