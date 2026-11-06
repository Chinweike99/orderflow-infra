import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from './user.entity.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOneBy({ email: email.toLowerCase() });
  }

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  create(
    email: string,
    passwordHash: string,
    role = UserRole.CUSTOMER,
  ): Promise<User> {
    return this.users.save(
      this.users.create({ email: email.toLowerCase(), passwordHash, role }),
    );
  }
}
