# RBAC + Email Integration Plan

**Repository:** `pav-backend` (Strapi v5.39, TypeScript)
**Scope:** Role-Based Access Control (RBAC) for business owners + transactional email (password recovery / invites) via Resend
**Prerequisite:** `DEPLOYMENT-PLAN.md` §1–§14 must be completed first

---

## 1. Architecture — Two Auth Systems

Strapi exposes two distinct authentication systems. They are completely separate:

```
┌──────────────────────────────────────────────────────────────────┐
│  STRAPI ADMIN PANEL  (/admin)                                     │
│  Auth: built-in admin auth  ·  Token: ADMIN_JWT_SECRET           │
│  Roles: Super Admin · Editor                                     │
│  Users: content managers (Spanish-speaking, non-technical)         │
│  Capabilities: manage ALL content · invite owners                  │
│                  assign listings/orgs/members to owners            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  FRONTEND OWNER PORTAL  (/iniciar-sesion · /mi-panel)            │
│  Auth: users-permissions plugin  ·  Token: JWT_SECRET             │
│  Roles: Owner                                                     │
│  Users: invited business owners (local entrepreneurs / guides)      │
│  Capabilities: edit OWN listing + organization + community-member  │
│  Endpoints: /api/auth/local · /api/auth/forgot-password          │
│             /api/auth/reset-password · /api/owners/invite (admin) │
└──────────────────────────────────────────────────────────────────┘
```

| | Admin panel auth | users-permissions auth |
|---|---|---|
| Token env var | `ADMIN_JWT_SECRET` | `JWT_SECRET` |
| Login URL | `/admin` | `/api/auth/local` |
| Roles | Super Admin, Editor (built-in) | Owner (custom) |
| Forgot password | Built-in email (needs SMTP) | Built-in `/api/auth/forgot-password` |
| Session | httpOnly cookie | JWT in Authorization header |

---

## 2. RBAC Roles & Permissions

### 2.1 Strapi Admin Panel Roles (built-in)

| Role | Manage content? | Invite owners? | Manage admin users? |
|---|:---:|:---:|:---:|
| **Super Admin** | ✅ everything | ✅ | ✅ |
| **Editor** | ✅ all content | ✅ | ❌ |

> The "Editor" role is created via **Admin Panel → Settings → Users & Permissions → Roles → Create role**. It receives all content-type permissions (find, findOne, create, update, delete) except user/role management permissions. Created once via the one-time admin setup (§11).

### 2.2 users-permissions Roles (JWT-authenticated portal)

| Role | Type | Created by |
|---|---|---|
| **Public** | `public` | Strapi default — already exists |
| **Authenticated** | `authenticated` | Strapi default — unused baseline |
| **Owner** | `owner` | **Seeded by `src/index.ts` bootstrap** |

### 2.3 Owner Permissions Matrix

| Content type | find | findOne | create | update | delete |
|---|:---:|:---:|:---:|:---:|:---:|
| `listing` | ✅ public | ✅ public | ❌ admin only | ✅ **own only** | ❌ |
| `organization` | ✅ public | ✅ public | ❌ admin only | ✅ **own only** | ❌ |
| `community-member` | ✅ public | ✅ public | ❌ admin only | ✅ **self only** | ❌ |
| `team-member` | ✅ public | ✅ public | ❌ | ❌ | ❌ |
| `category` | ✅ public | ✅ public | ❌ | ❌ | ❌ |
| `homepage` | ✅ public | ✅ public | ❌ | ❌ | ❌ |
| `site-global` | ✅ public | ✅ public | ❌ | ❌ | ❌ |
| `legal-page` | ✅ public | ✅ public | ❌ | ❌ | ❌ |
| `site-content` | ✅ public | ✅ public | ❌ | ❌ | ❌ |

**Design rationale:**
- Owners **read** all published content (same as public) — they browse the directory like anyone else
- Owners **update only their own records** — scoped via custom policies (`is-owner`, `is-self`)
- Owners **cannot create or delete** — this is a curated directory; admins create listings and assign them
- `create` stays admin-only so admins can review/approve before a listing goes live

---

## 3. Ownership Model

### 3.1 Three owner relations

Ownership is established via explicit relations (not `createdBy`, which tracks the admin who typed the record).

```
listing  ──manyToOne──▶  plugin::users-permissions.user
  (one owner, many listings)

organization  ──manyToOne──▶  plugin::users-permissions.user
  (one owner, many organizations)

community-member  ──oneToOne──▶  plugin::users-permissions.user
  (one person, one account — they ARE the user)
```

**Why not `createdBy`?** Admins create listings on behalf of owners. `createdBy` would be the admin's ID, not the owner's. An explicit `owner`/`user` field assigned by the admin is unambiguous.

### 3.2 Schema changes

**`src/api/listing/content-types/listing/schema.json`** — add `owner` relation:

```json
{
  "attributes": {
    "owner": {
      "type": "relation",
      "relation": "manyToOne",
      "target": "plugin::users-permissions.user",
      "inversedBy": "ownedListings"
    }
  }
}
```

**`src/api/organization/content-types/organization/schema.json`** — add `owner` relation:

```json
{
  "attributes": {
    "owner": {
      "type": "relation",
      "relation": "manyToOne",
      "target": "plugin::users-permissions.user",
      "inversedBy": "ownedOrganizations"
    }
  }
}
```

**`src/api/community-member/content-types/community-member/schema.json`** — add `user` relation (oneToOne — the community member IS the user):

```json
{
  "attributes": {
    "user": {
      "type": "relation",
      "relation": "oneToOne",
      "target": "plugin::users-permissions.user",
      "mappedBy": "communityMember"
    }
  }
}
```

### 3.3 Inverse relations on the User model

The Strapi `plugin::users-permissions.user` model does not exist as a schema file by default. To add the inverse relations, create:

**`src/extensions/users-permissions/content-types/user/schema.json`**:

```json
{
  "kind": "collectionType",
  "collectionName": "up_users",
  "info": {
    "name": "User",
    "description": ""
  },
  "options": {
    "draftAndPublish": false
  },
  "attributes": {
    "ownedListings": {
      "type": "relation",
      "relation": "oneToMany",
      "target": "api::listing.listing",
      "mappedBy": "owner"
    },
    "ownedOrganizations": {
      "type": "relation",
      "relation": "oneToMany",
      "target": "api::organization.organization",
      "mappedBy": "owner"
    },
    "communityMember": {
      "type": "relation",
      "relation": "oneToOne",
      "target": "api::community-member.community-member",
      "mappedBy": "user"
    }
  }
}
```

> Strapi v5 auto-discovers content types in `src/extensions/**/content-types/`. This extends the built-in user model with the three inverse relations without patching core files.

---

## 4. Ownership Scoping — Custom Policies

Three policies enforce that owners can only modify their own records.

### 4.1 `src/api/listing/policies/is-owner.ts`

```typescript
import { errors } from '@strapi/utils';

const { PolicyError } = errors;

export default async (policyContext, _config, { strapi }) => {
  const user = policyContext.state.user;
  if (!user) throw new PolicyError('Debes iniciar sesión');

  const { id } = policyContext.params;

  if (!id) {
    policyContext.query = {
      ...policyContext.query,
      filters: {
        ...(policyContext.query?.filters || {}),
        owner: user.id,
      },
    };
    return true;
  }

  const listing = await strapi.entityService.findOne('api::listing.listing', id, {
    populate: { owner: true },
  });

  if (!listing || listing.owner?.id !== user.id) {
    throw new PolicyError('No tienes permiso para editar este negocio');
  }

  return true;
};
```

### 4.2 `src/api/organization/policies/is-owner.ts`

```typescript
import { errors } from '@strapi/utils';

const { PolicyError } = errors;

export default async (policyContext, _config, { strapi }) => {
  const user = policyContext.state.user;
  if (!user) throw new PolicyError('Debes iniciar sesión');

  const { id } = policyContext.params;

  if (!id) {
    policyContext.query = {
      ...policyContext.query,
      filters: {
        ...(policyContext.query?.filters || {}),
        owner: user.id,
      },
    };
    return true;
  }

  const organization = await strapi.entityService.findOne(
    'api::organization.organization',
    id,
    { populate: { owner: true } }
  );

  if (!organization || organization.owner?.id !== user.id) {
    throw new PolicyError('No tienes permiso para editar esta organización');
  }

  return true;
};
```

### 4.3 `src/api/community-member/policies/is-self.ts`

```typescript
import { errors } from '@strapi/utils';

const { PolicyError } = errors;

export default async (policyContext, _config, { strapi }) => {
  const user = policyContext.state.user;
  if (!user) throw new PolicyError('Debes iniciar sesión');

  const { id } = policyContext.params;

  if (!id) {
    policyContext.query = {
      ...policyContext.query,
      filters: {
        ...(policyContext.query?.filters || {}),
        user: user.id,
      },
    };
    return true;
  }

  const member = await strapi.entityService.findOne(
    'api::community-member.community-member',
    id,
    { populate: { user: true } }
  );

  if (!member || member.user?.id !== user.id) {
    throw new PolicyError('No tienes permiso para editar este perfil');
  }

  return true;
};
```

---

## 5. Route Configuration — Attach Policies to update Action

The `update` action on listing, organization, and community-member must go through the ownership policy. Public `find`/`findOne` remain open.

### 5.1 `src/api/listing/routes/listing.ts`

```typescript
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::listing.listing', {
  only: ['find', 'findOne', 'update'],

  config: {
    find: {},
    findOne: {},
    update: {
      policies: ['global::is-owner'],
    },
  },
});
```

### 5.2 `src/api/organization/routes/organization.ts`

```typescript
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::organization.organization', {
  only: ['find', 'findOne', 'update'],

  config: {
    find: {},
    findOne: {},
    update: {
      policies: ['global::is-owner'],
    },
  },
});
```

### 5.3 `src/api/community-member/routes/community-member.ts`

```typescript
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::community-member.community-member', {
  only: ['find', 'findOne', 'update'],

  config: {
    find: {},
    findOne: {},
    update: {
      policies: ['global::is-self'],
    },
  },
});
```

> `global::` prefix registers the policy at the global level. Policy files go in `src/api/<name>/policies/` and are auto-registered by Strapi v5.

---

## 6. Email Integration — Resend via Nodemailer

### 6.1 Why Resend

- **3,000 emails/month free** — sufficient for ~82 owners with occasional resets/invites
- **SMTP relay** — works with `@strapi/provider-email-nodemailer` (no custom provider needed)
- **No sending domain required for testing** — use `onboarding@resend.dev` initially
- **Production-ready** — add `mail.puertoaguaverde.mx` as verified domain when ready

### 6.2 Provider choice

| Package | Version | Purpose |
|---|---|---|
| `@strapi/provider-email-nodemailer` | `5.39.0` | Strapi email plugin (SMTP transport) |
| `nodemailer` | `^6.9.0` | Underlying SMTP client (already used by the Strapi provider) |

### 6.3 `config/plugins.ts` — add email block

Add to the existing `config/plugins.ts`:

```typescript
const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  i18n: {
    enabled: true,
    config: {
      locales: ['es-MX', 'en'],
      defaultLocale: 'es-MX',
    },
  },

  upload: {
    config: {
      // ... existing R2 config (unchanged)
    },
  },

  // ─── NEW ────────────────────────────────────────────────────────────────
  email: {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST', 'smtp.resend.com'),
        port: env.int('SMTP_PORT', 465),
        secure: true,
        auth: {
          user: env('SMTP_USER', 'resend'),
          pass: env('SMTP_PASS'),
        },
      },
      settings: {
        defaultFrom: env('EMAIL_FROM', 'PAV Notificaciones <onboarding@resend.dev>'),
        defaultReplyTo: env('EMAIL_REPLY_TO', 'hola@puertoaguaverde.mx'),
      },
    },
  },
  // ─────────────────────────────────────────────────────────────────────
});

export default config;
```

### 6.4 Email triggers

| Event | Strapi endpoint | Email template | Language |
|---|---|---|---|
| Admin sends owner invite | `POST /api/owners/invite` | `invite-owner` (custom) | Spanish |
| Owner requests password reset | `POST /api/auth/forgot-password` | `reset_password` (override) | Spanish |
| New user email verification | `POST /api/auth/register` *(if enabled)* | `email_confirmation` (override) | Spanish |

All templates use Spanish subject lines, Spanish body text, and PAV branding.

---

## 7. Spanish Email Templates

Located at `src/extensions/users-permissions/utils/spanish-emails.ts`. These are strings used by the bootstrap to seed the templates into Strapi's DB (so the admin panel Settings → Email Templates shows correct values).

### 7.1 Reset password template

```typescript
export const resetPasswordSubject = 'Restablece tu contraseña — PAV';
export const resetPasswordBody = (url: string, user: { email: string }) => `
<!DOCTYPE html>
<html lang="es-MX">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; background: #FDFCF8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    .header { text-align: center; margin-bottom: 32px; }
    .logo { font-size: 24px; font-weight: bold; color: #5A8A80; }
    .card { background: #fff; border: 1px solid #e8e8e0; border-radius: 12px; padding: 32px; margin-bottom: 24px; }
    .btn { display: inline-block; background: #5A8A80; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; }
    .footer { text-align: center; color: #888; font-size: 12px; margin-top: 32px; }
    .note { background: #f9f9f5; border-left: 4px solid #5A8A80; padding: 12px 16px; margin: 16px 0; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><div class="logo">🌿 Puerto Agua Verde</div></div>
    <div class="card">
      <h2 style="margin-top:0">Hola,</h2>
      <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en Puerto Agua Verde.</p>
      <p>Si no hiciste esta solicitud, puedes ignorar este correo.</p>
      <div class="note">
        Este enlace expira en <strong>48 horas</strong> y solo puede usarse una vez.
      </div>
      <p style="text-align:center; margin: 32px 0">
        <a href="${url}" class="btn">Restablecer contraseña</a>
      </p>
      <p style="font-size:14px; color:#666">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>
      <a href="${url}" style="color:#5A8A80; word-break:break-all">${url}</a></p>
    </div>
    <div class="footer">
      Puerto Agua Verde · Rancho San Cosme, Baja California Sur, México<br>
      Este correo fue enviado porque se solicitó un restablecimiento de contraseña.
    </div>
  </div>
</body>
</html>
`;
```

### 7.2 Invite owner template (custom — used by `POST /api/owners/invite`)

```typescript
export const inviteOwnerSubject = 'Te invitaron a gestionar tu negocio en PAV 🌿';
export const inviteOwnerBody = (url: string, user: { email: string }) => `
<!DOCTYPE html>
<html lang="es-MX">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; background: #FDFCF8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
    .header { text-align: center; margin-bottom: 32px; }
    .logo { font-size: 24px; font-weight: bold; color: #5A8A80; }
    .card { background: #fff; border: 1px solid #e8e8e0; border-radius: 12px; padding: 32px; margin-bottom: 24px; }
    .btn { display: inline-block; background: #5A8A80; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: bold; }
    .footer { text-align: center; color: #888; font-size: 12px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><div class="logo">🌿 Puerto Agua Verde</div></div>
    <div class="card">
      <h2 style="margin-top:0">¡Te han invitado a Puerto Agua Verde!</h2>
      <p>Un administrador te creó una cuenta para que puedas gestionar la información de tu negocio en línea.</p>
      <p>Con tu cuenta podrás <strong>actualizar fotos, horarios, descripción y datos de contacto</strong> de tu negocio cuando tú quieras.</p>
      <p style="text-align:center; margin: 32px 0">
        <a href="${url}" class="btn">Crear mi contraseña</a>
      </p>
      <p style="font-size:14px; color:#666">Crea una contraseña segura para activar tu cuenta.<br>
      Si el botón no funciona, copia y pega: <a href="${url}" style="color:#5A8A80; word-break:break-all">${url}</a></p>
      <div style="background:#f9f9f5; padding:16px; border-radius:8px; margin-top:24px">
        <strong>¿No solicitaste esto?</strong> Puedes ignorar este correo. Solo un administrador puede enviar invitaciones.
      </div>
    </div>
    <div class="footer">
      Puerto Agua Verde · Rancho San Cosme, Baja California Sur, México
    </div>
  </div>
</body>
</html>
`;
```

---

## 8. Bootstrap — Seed Owner Role, Permissions & Email Templates

Extend `src/index.ts` to idempotently:

1. Create the `Owner` role (type: `owner`) if it doesn't exist
2. Grant it the permissions from the matrix (§2.3)
3. Seed Spanish email templates for `reset_password` and `email_confirmation` into Strapi's DB settings (only if not already set — so admin edits are preserved)

### 8.1 Bootstrap additions

Add to `src/index.ts`:

```typescript
import type { Core } from '@strapi/strapi';
import {
  resetPasswordSubject,
  resetPasswordBody,
  inviteOwnerSubject,
  inviteOwnerBody,
} from './extensions/users-permissions/utils/spanish-emails';

const PUBLIC_PERMISSIONS = [ /* ... existing list ... */ ];

const OWNER_PERMISSIONS = [
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::listing.listing.update',     // guarded by is-owner policy at route level
  'api::organization.organization.find',
  'api::organization.organization.findOne',
  'api::organization.organization.update',
  'api::community-member.community-member.find',
  'api::community-member.community-member.findOne',
  'api::community-member.community-member.update',
  'api::category.category.find',
  'api::category.category.findOne',
  'api::team-member.team-member.find',
  'api::team-member.team-member.findOne',
  'api::homepage.homepage.find',
  'api::site-global.site-global.find',
  'api::legal-page.legal-page.find',
  'api::legal-page.legal-page.findOne',
  'api::site-content.site-content.find',
  'api::site-content.site-content.findOne',
];

async function seedOwnerRole(strapi: Core.Strapi) {
  const roleService = strapi.db.query('plugin::users-permissions.role');
  let ownerRole = await roleService.findOne({ where: { type: 'owner' } });

  if (!ownerRole) {
    ownerRole = await roleService.create({
      data: {
        name: 'Dueño de Negocio',
        type: 'owner',
        description: 'Gestiona su propio negocio: listings, organización y perfil de miembro comunitario.',
      },
    });
    strapi.log.info(`[bootstrap] Created Owner role (id=${ownerRole.id})`);
  }

  const permService = strapi.db.query('plugin::users-permissions.permission');

  for (const action of OWNER_PERMISSIONS) {
    const existing = await permService.findOne({
      where: { action, role: ownerRole.id },
    });
    if (!existing) {
      await permService.create({ data: { action, role: ownerRole.id } });
      strapi.log.info(`[bootstrap] Granted Owner permission: ${action}`);
    }
  }
}

async function seedSpanishEmailTemplates(strapi: Core.Strapi) {
  const pluginStore = strapi.plugin('users-permissions').service('pluginStore');

  const templates = await pluginStore.get({ key: 'email_templates' });
  if (!templates) return;

  const frontendUrl = strapi.env('FRONTEND_URL', 'https://pav-frontend.pixie-cemodan.workers.dev');

  // Reset password — only override if not already customized
  if (!templates.reset_password?.body?.includes('PAV') && !templates.reset_password?.body?.includes('Restablece')) {
    templates.reset_password = {
      display: 'Email reset password',
      subject: resetPasswordSubject,
      body: resetPasswordBody(
        `${frontendUrl}/restablecer-contrasena?url={URL}`,
        { email: '{USER_EMAIL}' }
      ),
      from: undefined,
    };
    strapi.log.info('[bootstrap] Seeded Spanish reset_password template');
  }

  // Email confirmation — Spanish override
  if (!templates.email_confirmation?.body?.includes('PAV') && !templates.email_confirmation?.body?.includes('confirm')) {
    templates.email_confirmation = {
      display: 'Email confirmation',
      subject: 'Confirma tu correo — Puerto Agua Verde',
      body: `<p>Hola,</p><p>Por favor haz clic en el siguiente enlace para confirmar tu correo electrónico:</p><p><a href="{URL}">Confirmar mi correo</a></p>`,
      from: undefined,
    };
  }

  await pluginStore.set({ key: 'email_templates', value: templates });
}

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // ─── Existing public permission bootstrap ──────────────────────────
    const publicRole = await strapi.db
      .query('plugin::users-permissions.role')
      .findOne({ where: { type: 'public' } });

    if (!publicRole) {
      strapi.log.warn('Public role not found; skipping permission bootstrap');
    } else {
      for (const action of PUBLIC_PERMISSIONS) {
        const existing = await strapi.db
          .query('plugin::users-permissions.permission')
          .findOne({ where: { action, role: publicRole.id } });

        if (!existing) {
          await strapi.db
            .query('plugin::users-permissions.permission')
            .create({ data: { action, role: publicRole.id } });
          strapi.log.info(`[bootstrap] Granted public permission: ${action}`);
        }
      }
    }

    // ─── NEW: Owner role + permissions ────────────────────────────────
    await seedOwnerRole(strapi);

    // ─── NEW: Spanish email templates ─────────────────────────────────
    if (strapi.env('NODE_ENV') === 'production') {
      await seedSpanishEmailTemplates(strapi);
    }
  },
};
```

> Email templates are seeded only in `production` (not dev) so local development uses Strapi's default English templates. The `NODE_ENV=production` guard prevents template seeding during `pnpm dev`.

---

## 9. Custom Invite Controller — `POST /api/owners/invite`

A REST endpoint that admins call (from the frontend portal admin UI) to invite a business owner. It:
1. Creates (or finds) the users-permissions user with role `Owner`
2. Generates a password-reset token (without emailing the default template)
3. Sends a **custom invite email** via Resend

### 9.1 `src/api/owners/routes/owners.ts`

```typescript
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::owners.owners', {
  only: ['create'],
  config: {
    create: {
      roles: ['authenticated'],           // requires valid JWT
      policies: [],                       // admin panel guards access
    },
  },
});
```

### 9.2 `src/api/owners/controllers/owners.ts`

```typescript
import { errors } from '@strapi/utils';
const { PolicyError } = errors;

export default {
  async create(ctx) {
    const { email, listingIds = [], organizationIds = [], communityMemberId = null } = ctx.request.body;

    if (!email || typeof email !== 'string') {
      throw new PolicyError('El correo electrónico es requerido');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new PolicyError('El formato del correo no es válido');
    }

    const userService = strapi.plugin('users-permissions').service('user');
    const roleService = strapi.plugin('users-permissions').service('role');
    const emailService = strapi.plugin('email');

    // 1. Find or create user
    let user = await userService.findOne({ where: { email } });

    if (!user) {
      const ownerRole = await roleService.findOne({ where: { type: 'owner' } });
      if (!ownerRole) throw new PolicyError('Rol Owner no encontrado — ejecutar bootstrap');

      user = await userService.create({
        data: {
          email,
          provider: 'local',
          role: ownerRole.id,
          password: Math.random().toString(36).slice(2), // temp — will be reset via invite link
          confirmed: true,                               // skip email verification
        },
      });
      strapi.log.info(`[owners/invite] Created owner user id=${user.id} email=${email}`);
    }

    // 2. Assign content ownership
    if (listingIds.length) {
      for (const id of listingIds) {
        await strapi.entityService.update('api::listing.listing', id, {
          data: { owner: user.id },
        });
      }
    }
    if (organizationIds.length) {
      for (const id of organizationIds) {
        await strapi.entityService.update('api::organization.organization', id, {
          data: { owner: user.id },
        });
      }
    }
    if (communityMemberId) {
      await strapi.entityService.update('api::community-member.community-member', communityMemberId, {
        data: { user: user.id },
      });
    }

    // 3. Generate reset token (valid 48h)
    const resetToken = await strapi.plugin('users-permissions').service('user').getResetPasswordToken(user);

    // 4. Build invite URL
    const frontendUrl = strapi.env('FRONTEND_URL', 'https://pav-frontend.pixie-cemodan.workers.dev');
    const inviteUrl = `${frontendUrl}/establecer-contrasena?code=${encodeURIComponent(resetToken)}`;

    // 5. Send custom invite email via Resend
    const { inviteOwnerSubject, inviteOwnerBody } = await import(
      '../../extensions/users-permissions/utils/spanish-emails'
    );

    try {
      await emailService.send({
        to: email,
        from: strapi.env('EMAIL_FROM', 'PAV Notificaciones <onboarding@resend.dev>'),
        replyTo: strapi.env('EMAIL_REPLY_TO', 'hola@puertoaguaverde.mx'),
        subject: inviteOwnerSubject,
        html: inviteOwnerBody(inviteUrl, { email }),
      });
      strapi.log.info(`[owners/invite] Invite email sent to ${email}`);
    } catch (err) {
      strapi.log.error(`[owners/invite] Email failed for ${email}:`, err);
      // Don't fail the request — user was still created and assigned
      ctx.status = 202;
      return ctx.send({
        ok: true,
        userId: user.id,
        warning: 'Usuario creado pero el correo de invitación no se envió',
      });
    }

    ctx.status = 201;
    return ctx.send({ ok: true, userId: user.id });
  },
};
```

### 9.3 `src/api/owners/services/owners.ts`

```typescript
import { factories } from '@strapi/strapi';
export default factories.createCoreService('api::owners.owners');
```

---

## 10. JWT Payload — Include Role in Token

By default Strapi's JWT contains only `{ id, email, confirmed }`. The frontend portal needs to know the user's role without an extra API call.

**`src/extensions/users-permissions/strapi-server.js`**:

```javascript
const { translateUploadError } = require('../upload/utils/spanish-errors');

module.exports = (plugin) => {
  // ─── JWT: add role type to token payload ───────────────────────────────
  const originalCreateJwtToken = plugin.service('jwt').createJwtToken;
  plugin.service('jwt').createJwtToken = function (user) {
    const payload = { id: user.id, email: user.email };
    if (user.role?.type) payload.role = user.role.type;
    return originalCreateJwtToken.call(this, user, payload);
  };

  // ─── Upload: Spanish error translation (existing) ───────────────────────
  const methodsToWrap = ['upload', 'uploadFiles', 'replaceFile'];
  for (const methodName of methodsToWrap) {
    if (typeof plugin.controllers['admin-upload'][methodName] !== 'function') continue;
    const original = plugin.controllers['admin-upload'][methodName];
    plugin.controllers['admin-upload'][methodName] = async (ctx) => {
      try {
        return await original.call(plugin.controllers['admin-upload'], ctx);
      } catch (error) {
        throw translateUploadError(error);
      }
    };
  }

  const originalContentApiFactory = plugin.controllers['content-api'];
  plugin.controllers['content-api'] = ({ strapi }) => {
    const instance = originalContentApiFactory({ strapi });
    for (const methodName of methodsToWrap) {
      if (typeof instance[methodName] !== 'function') continue;
      const original = instance[methodName];
      instance[methodName] = async (ctx) => {
        try {
          return await original.call(instance, ctx);
        } catch (error) {
          throw translateUploadError(error);
        }
      };
    }
    return instance;
  };

  return plugin;
};
```

> This file now serves double duty: JWT role injection + existing Spanish upload error translation.

---

## 11. One-Time Admin Setup

After Koyeb deploy and data migration, perform these steps in the Strapi admin panel:

### 11.1 Create Editor role

1. **Settings → Users & Permissions → Roles → Create role**
2. Name: `Editor`
3. Under **Content Permissions**, grant all permissions for all content types (find, findOne, create, update, delete)
4. Under **Email", leave unchanged
5. Under **Users & Permissions**, grant `user.find` and `user.findOne` (so editors can see the user list)
6. **Do NOT** grant `role.*` or `user.create` / `user.delete` / `user.update` (only Super Admin manages users)

### 11.2 Create initial admin user (if not already)

**Settings → Users → Add new user** → invite a second content manager with role `Editor`.

### 11.3 Verify Owner role exists

Go to **Settings → Users & Permissions → Roles**. Verify a role named `Dueño de Negocio` (type `owner`) exists with the permissions from §2.3.

If missing (bootstrap failed), run `pnpm strapi console` locally against Neon and execute:

```js
await strapi.db.query('plugin::users-permissions.role').create({
  data: { name: 'Dueño de Negocio', type: 'owner', description: '...' }
});
```

### 11.4 Verify email templates

Go to **Settings → Users & Permissions → Email Templates**. Confirm `Reset password` shows Spanish subject/body. If blank, the bootstrap template seed ran but the panel needs a Strapi restart to pick up DB changes — restart the Koyeb service.

---

## 12. Owner Invite & Password Reset Flows

### 12.1 Invite owner (admin-initiated)

```
Admin (Owner Portal /mi-panel/admin/invitar)
  │
  ├─ POST /api/owners/invite
  │   { email, listingIds[], organizationIds[], communityMemberId }
  │
Backend
  ├─ Creates / finds user (role=Owner, confirmed=true)
  ├─ Sets owner relation on listings / orgs / member
  ├─ Generates reset token (48h, single-use)
  ├─ Sends invite email via Resend ────────────────────────▶ Owner inbox
  │   "Te han invitado a gestionar tu negocio en PAV"
  │   [Crear mi contraseña] → /establecer-contrasena?code=TOKEN
  │
  └─ ✅ 201 { ok: true, userId }
       │
Owner
  ├─ Clicks link → /establecer-contrasena?code=TOKEN
  ├─ POST /api/auth/reset-password
  │   { code: TOKEN, password: "NuevaContraseña123!" }
  ├─ ✅ 200 { jwt: "eyJ...", user: { id, email, role: "owner" } }
  ├─ Frontend stores JWT (httpOnly cookie)
  └─ Redirected to /mi-panel
```

### 12.2 Password reset (owner-initiated)

```
Owner (frontend /recuperar-contrasena)
  │
  ├─ POST /api/auth/forgot-password
  │   { email: "owner@example.com" }
  │
Backend (Strapi)
  ├─ Looks up user by email (no error if not found — security)
  ├─ Generates reset token (48h)
  ├─ Looks up email template "reset_password" in DB
  ├─ Renders Spanish template with invite URL
  ├─ Sends via Resend ─────────────────────────────────▶ Owner inbox
  │   "Restablece tu contraseña — PAV"
  │   [Restablecer contraseña] → /restablecer-contrasena?url=TOKEN
  │
  └─ ✅ 200 { ok: true }  (always, even if email not found)
       │
Owner
  ├─ Clicks link → /restablecer-contrasena?url=TOKEN
  ├─ POST /api/auth/reset-password
  │   { password: "NuevaContraseña456!" }
  ├─ ✅ 200 { jwt: "eyJ...", user: { id, email, role: "owner" } }
  └─ Logged in
```

---

## 13. Migration — Assign Existing Content to Owners

The 82 existing listings, organizations, and community-members have **no owner assigned** after the Neon migration. A one-time seed script maps existing content to owner accounts.

### 13.1 Input format — `scripts/owners-mapping.json`

```json
[
  {
    "ownerEmail": "lauras-tours@example.com",
    "listings": ["laura-kayak-tour", "pesca-deportiva-laura"],
    "organization": "lauras-tours-org",
    "communityMember": "laura-garcia"
  },
  {
    "ownerEmail": "carlos-arabe@example.com",
    "listings": ["cafe-laredo"],
    "organization": null,
    "communityMember": "carlos-arabe"
  }
]
```

### 13.2 `scripts/seed-owners.ts`

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Mapping {
  ownerEmail: string;
  listings?: string[];
  organization?: string | null;
  communityMember?: string | null;
}

async function seed() {
  const mapping: Mapping[] = JSON.parse(
    readFileSync(resolve(__dirname, 'owners-mapping.json'), 'utf-8')
  );

  const userService = strapi.plugin('users-permissions').service('user');
  const roleService = strapi.plugin('users-permissions').service('role');

  const ownerRole = await roleService.findOne({ where: { type: 'owner' } });
  if (!ownerRole) throw new Error('Owner role not found — run bootstrap first');

  for (const entry of mapping) {
    // Find or create user
    let user = await userService.findOne({ where: { email: entry.ownerEmail } });
    if (!user) {
      user = await userService.create({
        data: {
          email: entry.ownerEmail,
          provider: 'local',
          role: ownerRole.id,
          password: Math.random().toString(36).slice(2),
          confirmed: true,
        },
      });
      console.log(`[seed-owners] Created user ${entry.ownerEmail} (id=${user.id})`);
    }

    // Assign listings
    if (entry.listings?.length) {
      for (const slug of entry.listings) {
        const listing = await strapi.db
          .query('api::listing.listing')
          .findOne({ where: { slug }, select: ['id'] });
        if (listing) {
          await strapi.db
            .query('api::listing.listing')
            .update({ where: { id: listing.id }, data: { owner: user.id } });
          console.log(`[seed-owners] Assigned listing ${slug} → ${entry.ownerEmail}`);
        }
      }
    }

    // Assign organization
    if (entry.organization) {
      const org = await strapi.db
        .query('api::organization.organization')
        .findOne({ where: { slug: entry.organization }, select: ['id'] });
      if (org) {
        await strapi.db
          .query('api::organization.organization')
          .update({ where: { id: org.id }, data: { owner: user.id } });
        console.log(`[seed-owners] Assigned org ${entry.organization} → ${entry.ownerEmail}`);
      }
    }

    // Assign community member
    if (entry.communityMember) {
      const member = await strapi.db
        .query('api::community-member.community-member')
        .findOne({ where: { slug: entry.communityMember }, select: ['id'] });
      if (member) {
        await strapi.db
          .query('api::community-member.community-member')
          .update({ where: { id: member.id }, data: { user: user.id } });
        console.log(`[seed-owners] Assigned member ${entry.communityMember} → ${entry.ownerEmail}`);
      }
    }
  }

  console.log('[seed-owners] Done.');
}

seed().catch(console.error);
```

Run after Neon migration is complete:

```bash
# Set production env pointing to Neon
export DATABASE_CLIENT=postgres DATABASE_URL="postgresql://..." DATABASE_SSL=true
export R2_ENDPOINT=... R2_BUCKET=...  # Strapi needs these to start
export NODE_ENV=production

npx tsx scripts/seed-owners.ts
```

> **Provide the `owners-mapping.json`** with the actual owner-email → content mappings before running. Listings/orgs/members without a mapping remain admin-managed.

---

## 14. Env Vars — Additions to DEPLOYMENT-PLAN.md §5

Add these to the Koyeb env var matrix:

| Category | Key | Example value | Notes |
|---|---|---|---|
| Email | `SMTP_HOST` | `smtp.resend.com` | Resend SMTP relay |
| Email | `SMTP_PORT` | `465` | TLS |
| Email | `SMTP_USER` | `resend` | Fixed for Resend SMTP |
| Email | `SMTP_PASS` | `re_xxxxxxxxxxxx` | 🔒 = Resend API key |
| Email | `EMAIL_FROM` | `PAV Notificaciones <no-reply@mail.puertoaguaverde.mx>` | Sender; domain verified in Resend |
| Email | `EMAIL_REPLY_TO` | `hola@puertoaguaverde.mx` | Reply-to |
| Integration | `FRONTEND_URL` | `https://pav-frontend.pixie-cemodan.workers.dev` | For invite/reset email links |

---

## 15. Security Considerations

| Threat | Mitigation |
|---|---|
| JWT theft | httpOnly + Secure + SameSite=Lax cookie; 30-day TTL; rotate `JWT_SECRET` on suspected compromise |
| Brute-force login | Strapi built-in rate limit: 10 attempts/min → 429 |
| Reset token reuse | Strapi invalidates token immediately after first use |
| Reset token expiry | 48-hour window — stored in `up_forgot_password` table |
| Email enumeration | `forgot-password` always returns `{ok: true}` even if email not found |
| Owner edits others' listings | `is-owner` / `is-self` policies enforced at route level — cannot be bypassed from API |
| Admin escalates to Super Admin | Separate `ADMIN_JWT_SECRET` — never shared with frontend |
| SMTP credentials leak | `SMTP_PASS` stored as Koyeb secret env var; never in git |
| Spam via invite endpoint | Protected by admin JWT auth; no public unauthenticated invite |
| Community-member → user linking | Only admin can link a community-member to a user; `is-self` policy prevents tampering |

---

## 16. Alignment with DEPLOYMENT-PLAN.md

| DEPLOYMENT-PLAN.md section | RBAC/Email impact |
|---|---|
| §3.1 `config/server.ts` | No change |
| §3.2 `config/middlewares.ts` | No change |
| §3.3 `config/plugins.ts` | **Add `email` block** (nodemailer + Resend SMTP) |
| §3.5 `package.json` | **Add `@strapi/provider-email-nodemailer`, `nodemailer`** |
| §4 New files | Add `is-owner.ts`, `is-self.ts`, `strapi-server.js`, `spanish-emails.ts`, `seed-owners.ts`, `owners` API (routes/controller/service) |
| §5 Env var matrix | **Add 6 email vars** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_REPLY_TO`) |
| §8 Migration | Run `scripts/seed-owners.ts` **after** data-transfer import |
| §10 Admin setup | **Add: create Editor role; verify Owner role; verify Spanish email templates** |
| §12 Backend→Frontend contract | Owner portal routes use same JWT auth + `/api/auth/*` endpoints |
| §13 Cost | Resend free tier: 3,000 emails/month — ~$0/mo |

---

## 17. Files to Create / Modify

### New files

| File | Purpose |
|---|---|
| `src/extensions/users-permissions/content-types/user/schema.json` | Extend user model with 3 inverse relations |
| `src/extensions/users-permissions/strapi-server.js` | JWT role injection + upload error translation |
| `src/extensions/users-permissions/utils/spanish-emails.ts` | Spanish email template strings |
| `src/api/listing/policies/is-owner.ts` | Ownership policy for listings |
| `src/api/organization/policies/is-owner.ts` | Ownership policy for organizations |
| `src/api/community-member/policies/is-self.ts` | Ownership policy for community members |
| `src/api/listing/routes/listing.ts` | Attach `is-owner` policy to `update` |
| `src/api/organization/routes/organization.ts` | Attach `is-owner` policy to `update` |
| `src/api/community-member/routes/community-member.ts` | Attach `is-self` policy to `update` |
| `src/api/owners/routes/owners.ts` | Custom invite endpoint route |
| `src/api/owners/controllers/owners.ts` | Invite controller |
| `src/api/owners/services/owners.ts` | Service stub |
| `scripts/seed-owners.ts` | Assign existing content to owner accounts |
| `scripts/owners-mapping.json` | **User provides** — owner → content mapping |

### Files to modify

| File | Change |
|---|---|
| `config/plugins.ts` | Add `email` block |
| `package.json` | Add `@strapi/provider-email-nodemailer`, `nodemailer` |
| `src/index.ts` | Extend bootstrap: seed Owner role + permissions + Spanish email templates |
| `src/api/listing/content-types/listing/schema.json` | Add `owner` relation |
| `src/api/organization/content-types/organization/schema.json` | Add `owner` relation |
| `src/api/community-member/content-types/community-member/schema.json` | Add `user` relation |
| `.env.example` | Add `SMTP_*`, `EMAIL_*` vars |

---

## 18. Frontend Portal Reference

See **`FRONTEND-DEPLOYMENT.md` §new** for the owner portal frontend implementation:
- `/iniciar-sesion` — login form
- `/recuperar-contrasena` — request password reset
- `/restablecer-contrasena` — set new password (from email link)
- `/establecer-contrasena` — set initial password (from invite email)
- `/mi-panel` — owner dashboard (list their content)
- `/mi-panel/editar/[id]` — edit own listing/organization/member
- Auth middleware: httpOnly JWT cookie, role extraction from `user.role` in token

---

*Last updated: 2026-07-08 · aligned with DEPLOYMENT-PLAN.md (pav-backend main commit `0a42a0b`)*
