import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from './metrics.service.js';

const IGNORED_PATHS = new Set(['/metrics']);

/**
 * Records count and latency for every HTTP request, including ones rejected
 * by guards (401/403) that never reach a controller.
 *
 * The `route` label is the route template (e.g. /v1/orders/:id), never the
 * raw URL, otherwise every order ID would create a new time series.
 */
export function httpMetricsMiddleware(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (IGNORED_PATHS.has(req.path)) return next();

    const stopTimer = metrics.httpRequestDuration.startTimer();
    res.on('finish', () => {
      const template = (req.route as { path?: string } | undefined)?.path;
      const labels = {
        method: req.method,
        route: template ? `${req.baseUrl}${template}` : 'unmatched',
        status_code: String(res.statusCode),
      };
      stopTimer(labels);
      metrics.httpRequestsTotal.inc(labels);
    });
    next();
  };
}
