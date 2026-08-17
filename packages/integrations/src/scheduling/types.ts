/** The stable contract used by voice today and by future customer channels. */
export type BookingProvider = 'ezyvet' | 'google_calendar';

export interface BookingAppointmentType {
  readonly defaultDurationMinutes: number;
  readonly key: string;
  readonly name: string;
}

export interface BookingResource {
  readonly key: string;
  readonly name: string;
  /** Trusted provider-side metadata; never model-controlled. */
  readonly schedulingScopeKey: string | null;
}

export interface AvailabilityRequest {
  readonly appointmentType: BookingAppointmentType;
  readonly dates: readonly string[];
  readonly resources: readonly BookingResource[];
  readonly timezone: string;
  /** Trusted location policy supplied by the scheduling service, never the model. */
  readonly availabilityPolicy?: {
    readonly businessHours: Readonly<Record<string, { readonly close: string | null; readonly closed: boolean; readonly open: string | null }>>;
    readonly minimumLeadMinutes: number;
  };
}

export interface AvailabilitySlot {
  readonly appointmentTypeKey: string;
  readonly endAt: string;
  readonly providerDisplayName: string | null;
  readonly resourceKey: string;
  readonly startAt: string;
  readonly timezone: string;
}

/** A trusted booking customer, not necessarily a provider-side customer record. */
export interface BookingCustomer {
  readonly displayName: string | null;
  readonly providerKey?: string | null;
  readonly trustedPhoneE164?: string | null;
}

/** A pet, vehicle description, or other useful appointment context. */
export interface BookingSubject {
  readonly displayName: string | null;
  readonly providerKey?: string | null;
}

export interface BookingParty {
  readonly customer: BookingCustomer;
  readonly subject: BookingSubject;
}

export type BookingPartyResolution =
  | { readonly kind: 'resolved'; readonly party: BookingParty }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'ambiguous' };

export interface BookingPartyResolutionRequest {
  readonly subjectName: string | null;
  readonly trustedCallerE164: string | null;
  readonly trustedContactDisplayName: string | null;
  readonly trustedContactId: string | null;
}

export interface CreateBookingRequest {
  readonly appointmentType: BookingAppointmentType;
  /** Internal intent identity for deterministic provider idempotency; never model input. */
  readonly bookingIntentId?: string;
  /** Trusted integration identity for private provider reconciliation metadata. */
  readonly integrationId?: string;
  readonly customer: BookingCustomer;
  readonly description: string;
  readonly resource: BookingResource;
  readonly slot: AvailabilitySlot;
  readonly subject: BookingSubject;
}

export interface CreateBookingResult {
  readonly appointmentKey: string;
  readonly providerStatus: 'unconfirmed' | 'confirmed' | 'unknown';
}

export interface BookingReconciliationRequest {
  readonly appointmentType: BookingAppointmentType;
  readonly bookingIntentId?: string;
  /** Trusted integration identity used to verify provider-side reconciliation metadata. */
  readonly integrationId?: string;
  readonly customer: BookingCustomer;
  readonly resource: BookingResource;
  readonly slot: AvailabilitySlot;
  readonly subject: BookingSubject;
}

export type BookingReconciliationResult =
  | { readonly kind: 'found'; readonly appointment: CreateBookingResult }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'ambiguous' };

/**
 * A connector owns all provider-specific identity behaviour. ezyVet resolves an exact
 * Contact/Animal pair; Google Calendar carries trusted local caller context and never invents a
 * Google customer identifier.
 */
export interface BookingConnector {
  readonly provider: BookingProvider;
  createBooking(input: CreateBookingRequest): Promise<CreateBookingResult>;
  reconcileBooking?(input: BookingReconciliationRequest): Promise<BookingReconciliationResult>;
  getAvailability(input: AvailabilityRequest): Promise<readonly AvailabilitySlot[]>;
  resolveBookingParty(input: BookingPartyResolutionRequest): Promise<BookingPartyResolution>;
}

export interface SchedulingCatalog {
  readonly appointmentTypes: readonly BookingAppointmentType[];
  readonly resources: readonly BookingResource[];
  readonly site: { readonly id: string; readonly timezone: string };
}

/** Legacy ezyVet-only aliases retained for focused connector internals. */
export interface ExternalCustomer {
  readonly displayName: string | null;
  readonly key: string;
}
export interface ExternalSubject {
  readonly displayName: string;
  readonly key: string;
}
export type CustomerResolution =
  | { readonly kind: 'resolved'; readonly customer: ExternalCustomer }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'ambiguous' };
export type SubjectResolution =
  | { readonly kind: 'resolved'; readonly subject: ExternalSubject }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'ambiguous' };
export interface CustomerResolutionRequest { readonly trustedCallerE164: string; }
export interface SubjectResolutionRequest { readonly customer: ExternalCustomer; readonly petName: string; }
