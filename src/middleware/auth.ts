import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../lib/http';
import type { AuthUser, UserRole } from '../types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface JwtPayload {
  sub: string;
  name: string;
  email: string;
  role: UserRole;
  employeeId: string | null;
  businessId: string | null;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const query = req.query.token;
  if (typeof query === 'string' && query) return query;
  return null;
}

/** Exige un JWT válido. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readToken(req);
  if (!token) return next(HttpError.unauthorized('Falta el token de acceso'));

  try {
    const payload = jwt.verify(token, env.jwtSecret) as JwtPayload;
    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      employeeId: payload.employeeId ?? null,
      businessId: payload.businessId ?? null,
    };
    next();
  } catch {
    next(HttpError.unauthorized('Token inválido o expirado'));
  }
};

/** Obtiene el business_id para la petición actual (del usuario o header para SUPER_ADMIN) */
export function getTenantId(req: Request): string | null {
  if (req.user?.businessId) return req.user.businessId;
  if (req.user?.role === 'SUPER_ADMIN') {
    const headerBusinessId = req.headers['x-business-id'];
    if (typeof headerBusinessId === 'string' && headerBusinessId) {
      return headerBusinessId;
    }
  }
  return null;
}

/** Exige que la petición tenga un business_id válido para operar sobre un lavadero. */
export const requireTenant: RequestHandler = (req, _res, next) => {
  const businessId = getTenantId(req);
  if (!businessId) {
    return next(HttpError.badRequest('No se especificó un establecimiento válido'));
  }
  next();
};

/** Exige que el usuario tenga uno de los roles indicados. */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(HttpError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(HttpError.forbidden('Tu rol no tiene permiso para esta acción'));
    }
    next();
  };

