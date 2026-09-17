// Awaken IQ — Shared Management Auth Guard & Session Handler

(function () {
    async function checkAdminAuth() {
        try {
            const res = await fetch('/api/admin/me');
            if (!res.ok) {
                window.location.href = 'login.html';
                return null;
            }
            const data = await res.json();
            return data.user;
        } catch (err) {
            console.error('Auth check error:', err);
            window.location.href = 'login.html';
            return null;
        }
    }

    async function handleLogout() {
        try {
            await fetch('/api/admin/logout', { method: 'POST' });
        } catch (e) {
            console.error('Logout error:', e);
        } finally {
            window.location.href = 'login.html';
        }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        const user = await checkAdminAuth();
        if (!user) return;

        window.currentAdminUser = user;

        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                handleLogout();
            });
        }

        const navContainer = document.querySelector('header nav .flex.items-center.gap-4') || document.querySelector('header nav');
        if (navContainer && !document.getElementById('user-role-badge')) {
            const badge = document.createElement('div');
            badge.id = 'user-role-badge';
            badge.className = 'flex items-center gap-2 bg-primary/10 text-primary px-3 py-1.5 rounded-full text-xs font-semibold';
            
            const roleColor = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN' ? 'bg-amber-500' : 'bg-emerald-600';
            badge.innerHTML = `
                <span class="w-2 h-2 rounded-full ${roleColor} animate-pulse"></span>
                <span>${user.name || user.email} (${user.role})</span>
            `;
            
            if (logoutBtn) {
                navContainer.insertBefore(badge, logoutBtn);
            } else {
                navContainer.appendChild(badge);
            }
        }

        if (user.role === 'STAFF') {
            document.querySelectorAll('.admin-only-feature').forEach(el => el.classList.add('hidden'));
            
            const bulkImportHeader = Array.from(document.querySelectorAll('h3')).find(h => h.textContent.includes('Excel Bulk Import Utility'));
            if (bulkImportHeader) {
                const section = bulkImportHeader.closest('section');
                if (section) section.style.display = 'none';
            }
        }
    });
})();
