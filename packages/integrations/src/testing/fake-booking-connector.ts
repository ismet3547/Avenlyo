import type {
  AvailabilityRequest,
  AvailabilitySlot,
  AppointmentLifecycleRequest,
  AppointmentLifecycleState,
  AppointmentRescheduleRequest,
  BookingConnector,
  CreateBookingRequest,
  CreateBookingResult,
  BookingPartyResolution,
  BookingPartyResolutionRequest,
} from '../scheduling/types';

export class FakeBookingConnector implements BookingConnector {
  public readonly appointmentLifecycle = { canCancel: true, canReschedule: true } as const;
  public readonly provider = 'ezyvet' as const;
  public readonly bookings: CreateBookingRequest[] = [];
  public readonly availabilityRequests: AvailabilityRequest[] = [];
  public party: BookingPartyResolution = { kind: 'unresolved' };
  public slots: readonly AvailabilitySlot[] = [];
  public bookingResult: CreateBookingResult = {
    appointmentKey: 'appointment_fake_1',
    providerStatus: 'unconfirmed',
  };

  public createBooking(input: CreateBookingRequest): Promise<CreateBookingResult> {
    this.bookings.push(input);
    return Promise.resolve(this.bookingResult);
  }

  public getAvailability(input: AvailabilityRequest): Promise<readonly AvailabilitySlot[]> {
    this.availabilityRequests.push(input);
    return Promise.resolve(this.slots);
  }

  public cancelAppointment(input: AppointmentLifecycleRequest): Promise<AppointmentLifecycleState> {
    return Promise.resolve({ kind: 'cancelled', appointmentKey: input.appointmentKey });
  }

  public getAppointmentState(input: AppointmentLifecycleRequest | AppointmentRescheduleRequest): Promise<AppointmentLifecycleState> {
    return Promise.resolve({ kind: 'active', appointmentKey: input.appointmentKey });
  }

  public rescheduleAppointment(input: AppointmentRescheduleRequest): Promise<AppointmentLifecycleState> {
    return Promise.resolve({ kind: 'rescheduled', appointmentKey: input.appointmentKey });
  }

  public resolveBookingParty(input: BookingPartyResolutionRequest): Promise<BookingPartyResolution> {
    void input;
    return Promise.resolve(this.party);
  }
}
