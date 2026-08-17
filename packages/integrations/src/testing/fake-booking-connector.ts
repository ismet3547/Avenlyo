import type {
  AvailabilityRequest,
  AvailabilitySlot,
  BookingConnector,
  CreateBookingRequest,
  CreateBookingResult,
  CustomerResolution,
  CustomerResolutionRequest,
  SubjectResolution,
  SubjectResolutionRequest,
} from '../scheduling/types';

export class FakeBookingConnector implements BookingConnector {
  public readonly provider = 'ezyvet' as const;
  public readonly bookings: CreateBookingRequest[] = [];
  public readonly availabilityRequests: AvailabilityRequest[] = [];
  public customer: CustomerResolution = { kind: 'unresolved' };
  public slots: readonly AvailabilitySlot[] = [];
  public subject: SubjectResolution = { kind: 'unresolved' };
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

  public resolveCustomer(input: CustomerResolutionRequest): Promise<CustomerResolution> {
    void input;
    return Promise.resolve(this.customer);
  }

  public resolveSubject(input: SubjectResolutionRequest): Promise<SubjectResolution> {
    void input;
    return Promise.resolve(this.subject);
  }
}
