import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
    {
        path: 'login',
        loadComponent: () =>
            import('./features/auth/login.component').then((m) => m.LoginComponent),
    },
    {
        // Everything inside the shell requires being logged in
        path: '',
        canActivate: [authGuard],
        loadComponent: () =>
            import('./layout/shell.component').then((m) => m.ShellComponent),
        children: [
            {
                path: 'dashboard',
                loadComponent: () =>
                    import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
            },
            {
                path: 'reports', canActivate: [adminGuard],
                loadComponent: () =>
                    import('./features/reports/reports.component').then((m) => m.ReportsComponent),
            },
            {
                // ✅ REAL Objects feature (admin only)
                path: 'objects', canActivate: [adminGuard],
                loadComponent: () =>
                    import('./features/objects/objects.component').then((m) => m.ObjectsComponent),
            },
            {
                path: 'products',
                loadComponent: () =>
                    import('./features/products/products.component').then((m) => m.ProductsComponent),
            },
            {
                path: 'orders',
                loadComponent: () =>
                    import('./features/orders/orders.component').then((m) => m.OrdersComponent),
            },
            {
                path: 'orders/new',
                loadComponent: () =>
                    import('./features/orders/order-create.component').then((m) => m.OrderCreateComponent),
            },
            {
                path: 'inventory',
                loadComponent: () =>
                    import('./features/inventory/inventory.component').then((m) => m.InventoryComponent),
            },
            {
                path: 'users', canActivate: [adminGuard],
                loadComponent: () =>
                    import('./features/users/users.component').then((m) => m.UsersComponent),
            },
            {
                path: 'inventory/count',
                loadComponent: () =>
                    import('./features/stock-count/stock-count.component').then((m) => m.StockCountComponent),
                canActivate: [authGuard],
            },
            {
                path: 'inventory/counts',
                loadComponent: () =>
                    import('./features/stock-count/count-history.component').then((m) => m.CountHistoryComponent),
                canActivate: [authGuard],
            },
            {
                path: 'sales',
                loadComponent: () =>
                    import('./features/sales/sales.component').then((m) => m.SalesComponent),
                canActivate: [authGuard], // or [authGuard, adminGuard] if admin-only
            },
            {
                path: 'settings',
                loadComponent: () =>
                    import('./features/settings/settings.component').then((m) => m.SettingsComponent),
            },
            { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
        ],
    },
    { path: '**', redirectTo: 'dashboard' },
];