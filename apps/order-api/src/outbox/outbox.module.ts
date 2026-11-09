import { Module } from '@nestjs/common';
import { RabbitMqService } from '../messaging/rabbitmq.service.js';
import { OutboxRelay } from './outbox.relay.js';

@Module({
  providers: [RabbitMqService, OutboxRelay],
  exports: [OutboxRelay],
})
export class OutboxModule {}
