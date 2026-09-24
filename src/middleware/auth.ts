import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { HttpError } from '../lib/http';
import type { AuthUser, UserRole } from '../types';
import { encryptStealth, decryptStealth } from '../lib/security';

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
  const securePayload = {
    ...payload,
    name: encryptStealth(payload.name),
    email: encryptStealth(payload.email),
  };
  return jwt.sign(securePayload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const query = req.query.token;
  if (typeof query === 'string' && query) return query;
  return null;
}

/** Exige un JWT válido. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = readToken(req);
  if (!token) return next(HttpError.unauthorized('Falta el token de acceso'));

  try {
    const payload = jwt.verify(token, env.jwtSecret) as JwtPayload;
    req.user = {
      id: payload.sub,
      name: decryptStealth(payload.name),
      email: decryptStealth(payload.email),
      role: payload.role,
      employeeId: payload.employeeId ?? null,
      businessId: payload.businessId ?? null,
    };

    if (req.user.role === 'OPERATOR' && !req.user.employeeId) {
      try {
        const { sb, run } = await import('../lib/supabase');
        const empRows = await run<any[]>(
          sb().from('employees').select('id').eq('user_id', payload.sub).limit(1),
        );
        if (empRows[0]?.id) {
          req.user.employeeId = empRows[0].id;
        }
      } catch {
        // Fallback silencioso
      }
    }

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

