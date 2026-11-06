import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 1 schema: users, products, orders, order_items.
 * Written by hand (not generated) so the SQL is explicit and reviewable.
 * See docs/database-schema.md.
 */
export class InitialSchema1793969057000 implements MigrationInterface {
  name = 'InitialSchema1793969057000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE user_role AS ENUM ('CUSTOMER', 'ADMIN')`,
    );
    await queryRunner.query(
      `CREATE TYPE order_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')`,
    );

    await queryRunner.query(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         varchar(254) NOT NULL,
        password_hash varchar(255) NOT NULL,
        role          user_role    NOT NULL DEFAULT 'CUSTOMER',
        created_at    timestamptz  NOT NULL DEFAULT now(),
        updated_at    timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT uq_users_email UNIQUE (email)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE products (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sku        varchar(64)    NOT NULL,
        name       varchar(200)   NOT NULL,
        price      numeric(12, 2) NOT NULL,
        active     boolean        NOT NULL DEFAULT true,
        created_at timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT uq_products_sku UNIQUE (sku),
        CONSTRAINT ck_products_price CHECK (price >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE orders (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         uuid           NOT NULL,
        status          order_status   NOT NULL DEFAULT 'PENDING',
        total_amount    numeric(12, 2) NOT NULL,
        currency        char(3)        NOT NULL,
        idempotency_key varchar(100),
        failure_reason  text,
        created_at      timestamptz    NOT NULL DEFAULT now(),
        updated_at      timestamptz    NOT NULL DEFAULT now(),
        CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT uq_orders_user_idempotency UNIQUE (user_id, idempotency_key),
        CONSTRAINT ck_orders_total CHECK (total_amount >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_orders_user_created ON orders (user_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_orders_status ON orders (status)`,
    );

    await queryRunner.query(`
      CREATE TABLE order_items (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id   uuid           NOT NULL,
        product_id uuid           NOT NULL,
        quantity   integer        NOT NULL,
        unit_price numeric(12, 2) NOT NULL,
        CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
        CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
        CONSTRAINT ck_order_items_quantity CHECK (quantity > 0),
        CONSTRAINT ck_order_items_unit_price CHECK (unit_price >= 0)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_order_items_order ON order_items (order_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE order_items`);
    await queryRunner.query(`DROP TABLE orders`);
    await queryRunner.query(`DROP TABLE products`);
    await queryRunner.query(`DROP TABLE users`);
    await queryRunner.query(`DROP TYPE order_status`);
    await queryRunner.query(`DROP TYPE user_role`);
  }
}
