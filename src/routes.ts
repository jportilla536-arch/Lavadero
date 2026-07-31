import { Router } from 'express';
import { authRouter } from './modules/auth.routes';
import { customersRouter, vehiclesRouter } from './modules/customers.routes';
import { employeesRouter } from './modules/employees.routes';
import { expensesRouter } from './modules/expenses.routes';
import { ordersRouter } from './modules/orders.routes';
import { promotionsRouter } from './modules/promotions.routes';
import { reportsRouter } from './modules/reports.routes';
import { servicesRouter } from './modules/services.routes';
import { settingsRouter } from './modules/settings.routes';
import { uploadsRouter } from './modules/uploads.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/vehicles', vehiclesRouter);
apiRouter.use('/services', servicesRouter);
apiRouter.use('/promotions', promotionsRouter);
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/expenses', expensesRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/uploads', uploadsRouter);
