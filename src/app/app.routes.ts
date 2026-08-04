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
                path: 'users', canActivate: [adminGuard],
                loadComponent: () =>
                    import('./features/users/users.component').then((m) => m.UsersComponent),
            },
            {
                path: 'settings',
                loadComponent: () =>
                    import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
            },
            { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
        ],
    },
    { path: '**', redirectTo: 'dashboard' },
];