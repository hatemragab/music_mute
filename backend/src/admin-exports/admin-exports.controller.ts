import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  LimitAdmin,
  RequireAdminPermission,
} from '../admin/admin.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminExportsService } from './admin-exports.service.js';
import type { ExportDataset } from './export-query.js';

@Controller('admin/exports')
@LimitAdmin('export')
export class AdminExportsController {
  constructor(private readonly exports: AdminExportsService) {}
  @Get('jobs.csv')
  @RequireAdminPermission('exports.read', 'jobs.read')
  jobs(
    @Req() req: AuthRequest,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.send(req, res, 'jobs', query);
  }
  @Get('overview.csv')
  @RequireAdminPermission('exports.read', 'overview.read')
  overview(
    @Req() req: AuthRequest,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.send(req, res, 'overview', query);
  }

  private async send(
    req: AuthRequest,
    res: Response,
    dataset: ExportDataset,
    query: Record<string, unknown>,
  ) {
    const abort = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) abort.abort();
    };
    req.on('aborted', disconnect);
    res.on('close', disconnect);
    try {
      if (req.aborted || res.destroyed) abort.abort();
      const result = await this.exports.export(
        req.adminActor!,
        dataset,
        query,
        abort.signal,
      );
      if (abort.signal.aborted || res.destroyed) return;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      res.send(result.csv);
    } finally {
      req.off('aborted', disconnect);
      res.off('close', disconnect);
    }
  }
}
