import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data migration. Orders created before the outbox existed (Sprint 1) have no
 * order.created event, so the worker would never pick them up and they would
 * stay PENDING forever. This creates the missing events; the relay then
 * publishes them like any other.
 *
 * Safe to run on an empty database or more than once (NOT EXISTS guard).
 */
export class BackfillPendingOrderEvents1793990000001 implements MigrationInterface {
  name = 'BackfillPendingOrderEvents1793990000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at)
      SELECT 'order', o.id, 'order.created',
             jsonb_build_object(
               'orderId', o.id,
               'userId', o.user_id,
               'totalAmount', o.total_amount::text,
               'currency', trim(o.currency)
             ),
             now()
        FROM orders o
       WHERE o.status = 'PENDING'
         AND NOT EXISTS (
               SELECT 1 FROM outbox_events e
                WHERE e.aggregate_type = 'order' AND e.aggregate_id = o.id
             )
    `);
  }

  async down(): Promise<void> {
    // Nothing to undo: once published, the events have been processed.
  }
}
