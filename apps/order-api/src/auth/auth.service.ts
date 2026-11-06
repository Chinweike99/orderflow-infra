import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUniqueViolation } from '../common/postgres-errors.js';
import { toUserResponse, type UserResponse } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import type { JwtPayload } from './auth.types.js';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from './password.js';

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string): Promise<UserResponse> {
    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email is already registered');
    }
    try {
      const user = await this.users.create(email, await hashPassword(password));
      return toUserResponse(user);
    } catch (error) {
      // Two simultaneous registrations with the same email: the database decides.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }
  }

  async login(
    email: string,
    password: string,
    expiresInSeconds: number,
  ): Promise<LoginResponse> {
    const user = await this.users.findByEmail(email);
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: expiresInSeconds,
    };
  }

  async me(userId: string): Promise<UserResponse> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('User no longer exists');
    return toUserResponse(user);
  }
}
