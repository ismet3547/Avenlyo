export type BookingProvider = 'ezyvet';

export interface BookingAppointmentType {
  readonly defaultDurationMinutes: number;
  readonly key: string;
  readonly name: string;
}

export interface BookingResource {
  readonly key: string;
  readonly name: string;
  /** Trusted provider-side location/separation metadata; never model-controlled. */
  readonly schedulingScopeKey: string | null;
}

export interface AvailabilityRequest {
  readonly appointmentType: BookingAppointmentType;
  readonly dates: readonly string[];
  readonly resources: readonly BookingResource[];
  readonly timezone: string;
}

export interface AvailabilitySlot {
  readonly appointmentTypeKey: string;
  readonly endAt: string;
  readonly providerDisplayName: string | null;
  readonly resourceKey: string;
  readonly startAt: string;
  readonly timezone: string;
}

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

export interface CustomerResolutionRequest {
  readonly trustedCallerE164: string;
}

export interface SubjectResolutionRequest {
  readonly customer: ExternalCustomer;
  readonly petName: string;
}

export interface CreateBookingRequest {
  readonly appointmentType: BookingAppointmentType;
  readonly customer: ExternalCustomer;
  readonly description: string;
  readonly resource: BookingResource;
  readonly slot: AvailabilitySlot;
  readonly subject: ExternalSubject;
}

export interface CreateBookingResult {
  readonly appointmentKey: string;
  readonly providerStatus: 'unconfirmed' | 'confirmed' | 'unknown';
}

export interface BookingReconciliationRequest {
  readonly appointmentType: BookingAppointmentType;
  readonly customer: ExternalCustomer;
  readonly resource: BookingResource;
  readonly slot: AvailabilitySlot;
  readonly subject: ExternalSubject;
}

export type BookingReconciliationResult =
  | { readonly kind: 'found'; readonly appointment: CreateBookingResult }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'ambiguous' };

/** Provider-neutral contract. Future connectors can implement this without changing the runtime. */
export interface BookingConnector {
  readonly provider: BookingProvider;
  createBooking(input: CreateBookingRequest): Promise<CreateBookingResult>;
  reconcileBooking?(input: BookingReconciliationRequest): Promise<BookingReconciliationResult>;
  getAvailability(input: AvailabilityRequest): Promise<readonly AvailabilitySlot[]>;
  resolveCustomer(input: CustomerResolutionRequest): Promise<CustomerResolution>;
  resolveSubject(input: SubjectResolutionRequest): Promise<SubjectResolution>;
}

export interface SchedulingCatalog {
  readonly appointmentTypes: readonly BookingAppointmentType[];
  readonly resources: readonly BookingResource[];
  readonly site: { readonly id: string; readonly timezone: string };
}
