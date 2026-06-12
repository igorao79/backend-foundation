// Granular permissions: catalog + hasGranular + requirePermission.
// Two storage levels: User.permissions (global JSONB) and Member.permissions (per-tenant JSONB).
// Adding a permission to PERMISSIONS below is enough — middleware and admin editors pick it up.
import ApiError from './api.error.js';
import { DB } from '../db.js';

// ---- CATALOG (project-specific: replace with your own keys) ----
export const PERMISSIONS = [
    'admin.users.view', 'admin.users.edit',
    'admin.presets.view', 'admin.presets.create', 'admin.presets.edit', 'admin.presets.delete',
    'project.view', 'project.edit',
    'invoices.view', 'invoices.create',
    'withdrawals.view', 'withdrawals.manage', 'withdrawals.review',
];

export const PERMISSION_LABELS = {
    'admin.users.view': 'View users',
    // ...
};

/** Holding any of these mutators implies the view permission (the map key). */
export const VIEW_IMPLIED_BY = {
    'invoices.view': ['invoices.create'],
    'withdrawals.view': ['withdrawals.manage', 'withdrawals.review'],
};

export const allPermissions = () => Object.fromEntries(PERMISSIONS.map((p) => [p, true]));
export const allProjectPermissions = () => Object.fromEntries(
    PERMISSIONS.filter((p) => !p.startsWith('admin.') && !p.startsWith('account.')).map((p) => [p, true]));

// Namespaces that ONLY live on the global User.permissions:
const isProjectScoped = (permission) =>
    !permission.startsWith('admin.') && !permission.startsWith('account.');

// ---- ENGINE (universal) ----
export function hasGranular(perms, permission) {
    if (!perms) return false;
    if (perms[permission] === true) return true;
    for (const m of (VIEW_IMPLIED_BY[permission] || [])) if (perms[m] === true) return true;
    return false;
}

const projectIdOf = (req) => req.params?.id || req.params?.projectId || req.body?.project_id || null;

async function loadMembership(user, req) {
    const projectId = projectIdOf(req);
    if (!projectId) return null;
    return DB.ProjectMember.findOne({ where: { user_id: user.id, project_id: projectId } });
}

/**
 * requirePermission('invoices.view') — works for both global-admin users and per-tenant members.
 * Superadmin bypasses. Sets req.member on success.
 */
export function requirePermission(permission) {
    return async (req, res, next) => {
        try {
            const user = await DB.User.findByPk(req.userId);
            if (!user || user.blocked) throw ApiError.Unauthorized('Unauthorized');
            if (user.is_superadmin) { req.member = { permissions: {}, role: 'superadmin' }; return next(); }

            if (req.isAdmin) {
                if (hasGranular(user.permissions, permission)) { req.member = { permissions: user.permissions, role: 'admin' }; return next(); }
                const m = isProjectScoped(permission) ? await loadMembership(user, req) : null;
                if (m && hasGranular(m.permissions, permission)) { req.member = m; return next(); }
                throw ApiError.Forbidden(`Missing permission: ${permission}`);
            }

            const m = await loadMembership(user, req);
            if (!m) {
                throw projectIdOf(req)
                    ? ApiError.Forbidden(`Missing permission: ${permission}`)
                    : ApiError.BadRequest('Project ID required');
            }
            if (!hasGranular(m.permissions, permission)) throw ApiError.Forbidden(`Missing permission: ${permission}`);
            req.member = m;
            next();
        } catch (err) { next(err); }
    };
}

// ---- PRESETS: snapshot apply + anti-escalation (use in your users service) ----
const VALID_PERMISSION_KEYS = new Set(PERMISSIONS);

/** Whitelist keys against the catalog, coerce values to boolean. */
export function sanitizePermissionMap(map) {
    const cleaned = {};
    for (const [k, v] of Object.entries(map || {})) if (VALID_PERMISSION_KEYS.has(k)) cleaned[k] = !!v;
    return cleaned;
}

/**
 * Snapshot semantics: deep-copy the preset onto the user (overwrite, not merge).
 * Anti-escalation: a non-superadmin cannot grant a permission they don't hold, nor apply to self.
 */
export function applyPresetSnapshot({ editor, target, preset }) {
    if (!editor.is_superadmin && editor.id === target.id) throw ApiError.Forbidden('Cannot apply a preset to yourself');
    const snapshot = JSON.parse(JSON.stringify(preset.permissions || {}));
    if (!editor.is_superadmin) {
        for (const [k, val] of Object.entries(snapshot)) {
            if (val && !hasGranular(editor.permissions, k)) {
                throw ApiError.Forbidden(`Preset grants a permission you do not hold: ${k}`, 'PERMISSION_ESCALATION');
            }
        }
    }
    target.permissions = snapshot;
    target.changed?.('permissions', true);
    return snapshot;
}
