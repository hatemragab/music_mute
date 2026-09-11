import { applyDecorators, SetMetadata } from '@nestjs/common';
import type { AdminPermission, AdminRateClass } from './admin.types.js';

export const ADMIN_ROUTE = Symbol('ADMIN_ROUTE');
export const ADMIN_PERMISSION = Symbol('ADMIN_PERMISSION');
export const ADMIN_FRESH_AUTH = Symbol('ADMIN_FRESH_AUTH');
export const ADMIN_RATE_CLASS = Symbol('ADMIN_RATE_CLASS');

export const AdminRoute = () => SetMetadata(ADMIN_ROUTE, true);
export const RequireAdminPermission = (...permissions: AdminPermission[]) =>
  applyDecorators(
    AdminRoute(),
    SetMetadata(ADMIN_PERMISSION, Object.freeze([...permissions])),
  );
export const RequireFreshAdminAuth = () => SetMetadata(ADMIN_FRESH_AUTH, true);
export const LimitAdmin = (rateClass: AdminRateClass) =>
  SetMetadata(ADMIN_RATE_CLASS, rateClass);
