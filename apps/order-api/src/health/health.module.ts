import { Controller, Get, Module } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TerminusModule,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators.js';

/**
 * Two separate checks, matching Kubernetes probes:
 * - /health/live:  the process is running. Never checks dependencies; a
 *   database outage must not make Kubernetes restart every API pod.
 * - /health/ready: the pod can serve traffic (database reachable). Failing
 *   it removes the pod from the Service/load balancer until it recovers.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 2000 }),
    ]);
  }
}

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
