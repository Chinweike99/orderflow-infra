import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import type { UserResponse } from '../users/user.entity.js';
import { AuthService, type LoginResponse } from './auth.service.js';
import type { AuthUser } from './auth.types.js';
import { CurrentUser, Public } from './decorators.js';
import { LoginDto, RegisterDto } from './dto/credentials.dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<UserResponse> {
    return this.auth.register(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<LoginResponse> {
    return this.auth.login(
      dto.email,
      dto.password,
      this.config.get('JWT_EXPIRES_IN_SECONDS', { infer: true }),
    );
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<UserResponse> {
    return this.auth.me(user.id);
  }
}
