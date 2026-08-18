import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
    {
        // NEW public landing page — the marketing "front door".
        // pathMatch:'full' means this ONLY matches the exact empty URL ('/'),
        // so all existing in-app links (/dashboard, /orders, …) keep working
        // through the shell route below. Zero breaking changes.
        // LandingComponent forwards logged-in users to /dashboard in ngOnInit.
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
            import('./features/landing/landing.component').then((m) => m.LandingComponent),
    },
    {
        path: 'login',
        loadComponent: () =>
            import('./features/auth/login.component').then((m) => m.LoginComponent),
    },
    {
        // Everything inside the shell requires being logged in.
        // Still mounted at '' (prefix match) so URLs stay /dashboard, /orders, etc.
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
                canActivate: [authGuard],
            },
            {
                path: 'settings',
                loadComponent: () =>
                    import('./features/settings/settings.component').then((m) => m.SettingsComponent),
            },
            // NOTE: removed the old `{ path: '', redirectTo: 'dashboard' }` child —
            // the empty path now belongs to the public landing page above.
        ],
    },
    // Any unknown route → landing page
    { path: '**', redirectTo: '' },
];
