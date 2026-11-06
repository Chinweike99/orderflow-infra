import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { User } from '../../users/user.entity.js';
import { OrderItem } from './order-item.entity.js';
import { OrderStatus } from './order-status.enum.js';

export const ORDER_IDEMPOTENCY_CONSTRAINT = 'uq_orders_user_idempotency';

@Entity({ name: 'orders' })
@Unique(ORDER_IDEMPOTENCY_CONSTRAINT, ['userId', 'idempotencyKey'])
@Index('idx_orders_user_created', ['userId', 'createdAt'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user: Relation<User>;

  @Index('idx_orders_status')
  @Column({
    type: 'enum',
    enum: OrderStatus,
    enumName: 'order_status',
    default: OrderStatus.PENDING,
  })
  status: OrderStatus;

  @Column({ name: 'total_amount', type: 'numeric', precision: 12, scale: 2 })
  totalAmount: string;

  @Column({ type: 'char', length: 3 })
  currency: string;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  idempotencyKey: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items: Relation<OrderItem[]>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
