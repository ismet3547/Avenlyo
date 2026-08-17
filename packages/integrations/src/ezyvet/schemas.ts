import { BookingProviderError } from '../scheduling/errors';

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BookingProviderError('provider_error');
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function items(value: unknown): readonly unknown[] {
  const root = record(value);
  return array(root.items ?? root.data);
}
