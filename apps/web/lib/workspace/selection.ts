import type { WorkspaceContextRow } from '@avenlyo/database';

/**
 * Workspace selection.
 *
 * A user may legitimately own one organization and be invited to another, or hold two locations in
 * the same one. The selection records which of those they are currently working in.
 *
 * The selection is a preference and never an authority. Role, organization, and location are always
 * re-derived from the database on the request that uses them, because membership can be revoked and
 * a location can be unassigned between one request and the next. This module is pure so the rules
 * can be asserted without a server.
 */

export const WORKSPACE_SELECTION_COOKIE = 'avenlyo_workspace';

export interface WorkspaceOption {
  readonly locationId: string | null;
  readonly locationName: string | null;
  readonly membershipId: string;
  readonly onboardingStatus: 'in_progress' | 'completed' | null;
  readonly onboardingStep: string | null;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: 'owner' | 'admin' | 'member';
}

export interface WorkspaceSelection {
  readonly locationId: string | null;
  readonly organizationId: string;
}

export type WorkspaceResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'onboarding'; readonly option: WorkspaceOption }
  | { readonly kind: 'resolved'; readonly option: WorkspaceOption }
  | { readonly kind: 'select'; readonly options: readonly WorkspaceOption[] };

export function toWorkspaceOption(row: WorkspaceContextRow): WorkspaceOption {
  return {
    locationId: row.location_id,
    locationName: row.location_name,
    membershipId: row.membership_id,
    onboardingStatus: row.onboarding_status,
    onboardingStep: row.onboarding_step,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    role: row.membership_role,
  };
}

/**
 * The opaque key a selection form submits. Deliberately not a role or a permission: it names a
 * position, and the server proves the caller may occupy it before anything is stored.
 */
export function workspaceOptionKey(option: WorkspaceSelection): string {
  return `${option.organizationId}:${option.locationId ?? ''}`;
}

export function parseWorkspaceSelection(
  value: string | null | undefined,
): WorkspaceSelection | null {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const organizationId = value.slice(0, separator);
  const locationId = value.slice(separator + 1);
  // Shape only. Whether the caller may use these identifiers is a database question, asked later.
  if (!isUuid(organizationId)) return null;
  if (locationId.length > 0 && !isUuid(locationId)) return null;
  return { locationId: locationId.length > 0 ? locationId : null, organizationId };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Matches a stored selection against what the caller may actually use right now. */
export function findSelectedOption(
  options: readonly WorkspaceOption[],
  selection: WorkspaceSelection | null,
): WorkspaceOption | null {
  if (!selection) return null;
  return (
    options.find(
      (option) =>
        option.organizationId === selection.organizationId &&
        option.locationId === selection.locationId,
    ) ?? null
  );
}

/**
 * The one place that decides where an authenticated user goes.
 *
 * A stale selection is never followed. If the stored context is no longer in the caller's authorized
 * set -- membership revoked, location unassigned, location deleted -- resolution starts again from
 * what they can actually reach, rather than continuing with identifiers that used to be valid.
 */
export function resolveWorkspace(
  options: readonly WorkspaceOption[],
  selection: WorkspaceSelection | null,
): WorkspaceResolution {
  if (options.length === 0) {
    return { kind: 'none' };
  }

  const selected = findSelectedOption(options, selection);
  if (selected) {
    return selected.onboardingStatus === 'completed'
      ? { kind: 'resolved', option: selected }
      : { kind: 'onboarding', option: selected };
  }

  // An owner still finishing setup has exactly one place to be, and sending them to a selector
  // instead of their next onboarding step would be a dead end.
  const incomplete = options.filter((option) => option.onboardingStatus !== 'completed');
  const usable = options.filter((option) => option.onboardingStatus === 'completed');

  if (usable.length === 1 && incomplete.length === 0) {
    const only = usable[0];
    return only ? { kind: 'resolved', option: only } : { kind: 'none' };
  }

  if (usable.length === 0) {
    const first = incomplete[0];
    return first ? { kind: 'onboarding', option: first } : { kind: 'none' };
  }

  return { kind: 'select', options: usable };
}

/** True when the dashboard should offer a switcher at all. One context needs no clutter. */
export function hasMultipleWorkspaces(options: readonly WorkspaceOption[]): boolean {
  return options.filter((option) => option.onboardingStatus === 'completed').length > 1;
}
