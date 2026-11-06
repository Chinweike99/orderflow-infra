import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'products' })
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  sku: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  /** NUMERIC(12,2), returned by the driver as a string, e.g. "19.99". */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  price: string;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
