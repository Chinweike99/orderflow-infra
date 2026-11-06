import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { UserRole } from '../../users/user.entity.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../decorators.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorReturning(metadata: Record<string, unknown>): Reflector {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation(
    (key: unknown) => metadata[key as string],
  );
  return reflector;
}

describe('JwtAuthGuard', () => {
  const jwt = { verifyAsync: vi.fn() };

  beforeEach(() => {
    jwt.verifyAsync.mockReset();
  });

  it('allows @Public() routes without a token', async () => {
    const guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflectorReturning({ [IS_PUBLIC_KEY]: true }),
    );
    await expect(guard.canActivate(contextFor({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects requests without a bearer token', async () => {
    const guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflectorReturning({}),
    );
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Basic abc' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid token', async () => {
    jwt.verifyAsync.mockRejectedValue(new Error('bad signature'));
    const guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflectorReturning({}),
    );
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer forged' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the user for a valid token', async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u1',
      email: 'a@b.co',
      role: UserRole.ADMIN,
    });
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer good' },
    };
    const guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
      reflectorReturning({}),
    );

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 'u1',
      email: 'a@b.co',
      role: UserRole.ADMIN,
    });
  });
});

describe('RolesGuard', () => {
  it('allows routes without @Roles()', () => {
    const guard = new RolesGuard(reflectorReturning({}));
    expect(
      guard.canActivate(contextFor({ user: { role: UserRole.CUSTOMER } })),
    ).toBe(true);
  });

  it('allows a user with a required role', () => {
    const guard = new RolesGuard(
      reflectorReturning({ [ROLES_KEY]: [UserRole.ADMIN] }),
    );
    expect(
      guard.canActivate(contextFor({ user: { role: UserRole.ADMIN } })),
    ).toBe(true);
  });

  it('forbids a user without a required role', () => {
    const guard = new RolesGuard(
      reflectorReturning({ [ROLES_KEY]: [UserRole.ADMIN] }),
    );
    expect(() =>
      guard.canActivate(contextFor({ user: { role: UserRole.CUSTOMER } })),
    ).toThrow(ForbiddenException);
  });
});
