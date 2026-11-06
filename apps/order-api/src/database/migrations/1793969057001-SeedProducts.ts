import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A small demo catalogue. Prices always come from here, never from the client. */
const PRODUCTS: [sku: string, name: string, price: string][] = [
  ['KB-MECH-01', 'Mechanical Keyboard', '89.99'],
  ['MS-WIRE-01', 'Wireless Mouse', '29.50'],
  ['MN-27-4K', '27" 4K Monitor', '349.00'],
  ['HS-NC-01', 'Noise-Cancelling Headset', '149.95'],
  ['CB-USBC-2M', 'USB-C Cable (2 m)', '12.00'],
  ['DK-USBC-01', 'USB-C Docking Station', '119.00'],
];

export class SeedProducts1793969057001 implements MigrationInterface {
  name = 'SeedProducts1793969057001';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [sku, name, price] of PRODUCTS) {
      await queryRunner.query(
        `INSERT INTO products (sku, name, price) VALUES ($1, $2, $3)
         ON CONFLICT (sku) DO NOTHING`,
        [sku, name, price],
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM products WHERE sku = ANY($1)`, [
      PRODUCTS.map(([sku]) => sku),
    ]);
  }
}
