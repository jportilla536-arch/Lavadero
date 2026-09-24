import { Router } from 'express';
import { authRouter } from './modules/auth.routes';
import { customersRouter, vehiclesRouter } from './modules/customers.routes';
import { employeesRouter } from './modules/employees.routes';
import { electronicInvoicesRouter } from './modules/electronic-invoices.routes';
import { expensesRouter } from './modules/expenses.routes';
import { ordersRouter } from './modules/orders.routes';
import { promotionsRouter } from './modules/promotions.routes';
import { reportsRouter } from './modules/reports.routes';
import { servicesRouter } from './modules/services.routes';
import { settingsRouter } from './modules/settings.routes';
import { superadminRouter } from './modules/superadmin.routes';
import { uploadsRouter } from './modules/uploads.routes';
import { securityRouter } from './modules/security.routes';
import { decryptPayload } from './middleware/decryptPayload.middleware';

export const apiRouter = Router();

// Middleware de descifrado E2EE RSA-OAEP / SHA-256 estilo Cootranar
apiRouter.use(decryptPayload);

apiRouter.use('/auth', authRouter);
apiRouter.use('/superadmin', superadminRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/vehicles', vehiclesRouter);
apiRouter.use('/services', servicesRouter);
apiRouter.use('/promotions', promotionsRouter);
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/electronic-invoices', electronicInvoicesRouter);
apiRouter.use('/expenses', expensesRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/uploads', uploadsRouter);
apiRouter.use('/security', securityRouter);

