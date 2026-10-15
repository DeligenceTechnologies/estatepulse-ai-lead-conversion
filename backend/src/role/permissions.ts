export const PERMISSIONS = {
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_UPDATE: 'organization.update',

  USER_READ: 'user.read',
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',

  ROLE_READ: 'role.read',
  ROLE_CREATE: 'role.create',
  ROLE_UPDATE: 'role.update',
  ROLE_DELETE: 'role.delete',

  LEAD_READ: 'lead.read',
  LEAD_UPDATE: 'lead.update',
  LEAD_ASSIGN: 'lead.assign',
  LEAD_IMPORT: 'lead.import',

  INTEGRATION_READ: 'integration.read',
  INTEGRATION_UPDATE: 'integration.update',

  AUTOMATION_READ: 'automation.read',
  AUTOMATION_UPDATE: 'automation.update',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export interface PermissionGroup {
  module: string;
  label: string;
  permissions: { key: Permission; label: string }[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    module: 'organization',
    label: 'Organization',
    permissions: [
      { key: PERMISSIONS.ORGANIZATION_READ, label: 'View organization' },
      { key: PERMISSIONS.ORGANIZATION_UPDATE, label: 'Edit organization settings' },
    ],
  },
  {
    module: 'user',
    label: 'Users',
    permissions: [
      { key: PERMISSIONS.USER_READ, label: 'View users' },
      { key: PERMISSIONS.USER_CREATE, label: 'Invite / create users' },
      { key: PERMISSIONS.USER_UPDATE, label: 'Edit users and assign roles' },
      { key: PERMISSIONS.USER_DELETE, label: 'Delete users' },
    ],
  },
  {
    module: 'role',
    label: 'Roles & permissions',
    permissions: [
      { key: PERMISSIONS.ROLE_READ, label: 'View roles' },
      { key: PERMISSIONS.ROLE_CREATE, label: 'Create roles' },
      { key: PERMISSIONS.ROLE_UPDATE, label: 'Edit roles and their permissions' },
      { key: PERMISSIONS.ROLE_DELETE, label: 'Delete roles' },
    ],
  },
  {
    module: 'lead',
    label: 'Leads',
    permissions: [
      { key: PERMISSIONS.LEAD_READ, label: 'View all leads, calls and conversations' },
      { key: PERMISSIONS.LEAD_UPDATE, label: 'Change lead status and start outreach' },
      { key: PERMISSIONS.LEAD_ASSIGN, label: 'Assign leads to agents' },
      { key: PERMISSIONS.LEAD_IMPORT, label: 'Import leads and review imports' },
    ],
  },
  {
    module: 'integration',
    label: 'Integrations',
    permissions: [
      { key: PERMISSIONS.INTEGRATION_READ, label: 'View lead sources and connected accounts' },
      { key: PERMISSIONS.INTEGRATION_UPDATE, label: 'Connect and manage lead sources and accounts' },
    ],
  },
  {
    module: 'automation',
    label: 'AI and automation',
    permissions: [
      { key: PERMISSIONS.AUTOMATION_READ, label: 'View the AI assistant, outreach strategy and sequences' },
      { key: PERMISSIONS.AUTOMATION_UPDATE, label: 'Edit the AI assistant, outreach strategy and sequences' },
    ],
  },
];

export const DEFAULT_ROLES = {
  OWNER: {
    name: 'Owner',
    description: 'Full access to everything in the organization.',
    isSystem: true,
    permissions: [] as Permission[],
  },
  AGENT: {
    name: 'Agent',
    description: 'Works leads assigned to them.',
    isSystem: false,
    permissions: [] as Permission[],
  },
} as const;

/** A user holding several roles gets every permission of each; the system role grants all. */
export function effectivePermissions(roles: readonly { isSystem: boolean; permissions: string[] }[]): string[] {
  if (roles.some((role) => role.isSystem)) return [...ALL_PERMISSIONS];
  return [...new Set(roles.flatMap((role) => role.permissions))];
}
