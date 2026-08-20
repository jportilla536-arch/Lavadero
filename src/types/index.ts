// =====================================================================
//  Tipos y enums compartidos (equivalentes a los ENUM de PostgreSQL)
// =====================================================================

export const USER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'CASHIER', 'OPERATOR'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const VEHICLE_TYPES = ['CAR', 'PICKUP', 'MOTORCYCLE', 'TRUCK'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const ORDER_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'READY',
  'FINISHED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const DISCOUNT_TYPES = ['AMOUNT', 'PERCENT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const EVIDENCE_STAGES = ['INITIAL', 'FINAL'] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

export const DAMAGE_TYPES = [
  'NONE',
  'SCRATCH',
  'DENT',
  'BROKEN_MIRROR',
  'BROKEN_GLASS',
  'OTHER',
] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export const PAYMENT_METHODS = ['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const EXPENSE_CATEGORIES = [
  'SUPPLIES',
  'SALARY',
  'SERVICES',
  'MAINTENANCE',
  'OTHER',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Transiciones de estado permitidas para una orden. */
export const ORDER_STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['IN_PROGRESS', 'READY', 'CANCELLED'],
  IN_PROGRESS: ['READY', 'PENDING', 'CANCELLED'],
  READY: ['FINISHED', 'IN_PROGRESS', 'CANCELLED'],
  FINISHED: [],
  CANCELLED: [],
};

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  employeeId: string | null;
  businessId: string | null;
}
