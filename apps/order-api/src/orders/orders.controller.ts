import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { ListOrdersQuery } from './dto/list-orders.query.js';
import type { OrderResponse } from './order.response.js';
import { OrdersService } from './orders.service.js';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,100}$/;

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Optional `Idempotency-Key` header: retrying the same request with the same
   * key returns the original order instead of creating a duplicate.
   */
  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retrying with the same key returns the original order',
  })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponse> {
    if (
      idempotencyKey !== undefined &&
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new BadRequestException(
        'Idempotency-Key must be 1-100 characters: letters, digits, _ - : .',
      );
    }
    const { order, replayed } = await this.orders.create(
      user,
      dto,
      idempotencyKey,
    );
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return order;
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQuery) {
    return this.orders.list(user, query);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<OrderResponse> {
    return this.orders.findOne(user, id);
  }
}
