import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sprint 2: transactional outbox (ADR-0002) and idempotent consumer tracking.
 * `processed_messages` is written only by the Order Worker, but the Order API
 * owns all schema migrations (see docs/database-schema.md).
 */
export class OutboxAndProcessedMessages1793990000000 implements MigrationInterface {
  name = 'OutboxAndProcessedMessages1793990000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_type   varchar(50)  NOT NULL,
        aggregate_id     uuid         NOT NULL,
        event_type       varchar(100) NOT NULL,
        payload          jsonb        NOT NULL,
        publish_attempts integer      NOT NULL DEFAULT 0,
        last_error       text,
        created_at       timestamptz  NOT NULL DEFAULT now(),
        published_at     timestamptz
      )
    `);
    // The relay only ever looks for unpublished rows, oldest first.
    await queryRunner.query(`
      CREATE INDEX idx_outbox_unpublished ON outbox_events (created_at)
      WHERE published_at IS NULL
    `);
    await queryRunner.query(
      `CREATE INDEX idx_outbox_aggregate ON outbox_events (aggregate_type, aggregate_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE processed_messages (
        message_id   uuid         NOT NULL,
        consumer     varchar(100) NOT NULL,
        processed_at timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT pk_processed_messages PRIMARY KEY (message_id, consumer)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE processed_messages`);
    await queryRunner.query(`DROP TABLE outbox_events`);
  }
}
