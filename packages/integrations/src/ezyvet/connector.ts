import type {
  AvailabilityRequest,
  AvailabilitySlot,
  BookingConnector,
  BookingReconciliationRequest,
  BookingReconciliationResult,
  CreateBookingRequest,
  CreateBookingResult,
  CustomerResolution,
  CustomerResolutionRequest,
  BookingPartyResolution,
  BookingPartyResolutionRequest,
  SchedulingCatalog,
  SubjectResolution,
  SubjectResolutionRequest,
} from '../scheduling/types';

import { loadAvailability } from './availability';
import { resolveOwnedAnimal } from './animals';
import { createEzyVetBooking } from './booking';
import { loadAppointmentTypes, loadCalendarResources } from './catalog';
import type { EzyVetClient } from './client';
import { resolveExactPhoneCustomer } from './contacts';
import { reconcileEzyVetBooking } from './reconciliation';
import { array, record, string } from './schemas';
import type { EzyVetCatalogConnector, EzyVetSite } from './types';

function siteFromPayload(value: unknown): EzyVetSite {
  try {
    const root = record(value);
    const data = record(root.data);
    const id = string(data.id);
    const timezoneReference = record(record(data.relationships).timezone).data;
    const timezoneId = string(record(timezoneReference).id);
    const timezone = array(root.included)
      .map(record)
      .find((entry) => string(entry.type) === 'timezone' && string(entry.id) === timezoneId);
    const timezoneName = timezone ? string(record(timezone.attributes).name) : null;
    if (!id || !timezoneId || !timezoneName || !validTimeZone(timezoneName)) {
      throw new Error('invalid site information');
    }
    return { id, timezone: timezoneName };
  } catch {
    throw new Error('ezyVet site information was incomplete or invalid.');
  }
}

function validTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export class EzyVetConnector implements BookingConnector, EzyVetCatalogConnector {
  public readonly provider = 'ezyvet' as const;

  public constructor(private readonly client: EzyVetClient) {}

  public supportsBooking(): boolean {
    return this.client.supportsEzyCab();
  }

  public async createBooking(input: CreateBookingRequest): Promise<CreateBookingResult> {
    return createEzyVetBooking(this.client, input);
  }

  public async reconcileBooking(
    input: BookingReconciliationRequest,
  ): Promise<BookingReconciliationResult> {
    return reconcileEzyVetBooking(this.client, input);
  }

  public async getAvailability(input: AvailabilityRequest): Promise<readonly AvailabilitySlot[]> {
    return loadAvailability(this.client, input);
  }

  public async getSchedulingCatalog(): Promise<SchedulingCatalog> {
    const [site, appointmentTypes, resources] = await Promise.all([
      this.getSite(),
      loadAppointmentTypes(this.client),
      loadCalendarResources(this.client),
    ]);
    return { appointmentTypes, resources, site };
  }

  public async getSite(): Promise<EzyVetSite> {
    return siteFromPayload(await this.client.getCore('/v3/siteInformation'));
  }

  public async resolveCustomer(input: CustomerResolutionRequest): Promise<CustomerResolution> {
    return resolveExactPhoneCustomer(this.client, input.trustedCallerE164);
  }

  public async resolveSubject(input: SubjectResolutionRequest): Promise<SubjectResolution> {
    return resolveOwnedAnimal(this.client, input.customer, input.petName);
  }

  public async resolveBookingParty(
    input: BookingPartyResolutionRequest,
  ): Promise<BookingPartyResolution> {
    if (!input.trustedCallerE164 || !input.subjectName) return { kind: 'unresolved' };
    const customer = await this.resolveCustomer({ trustedCallerE164: input.trustedCallerE164 });
    if (customer.kind !== 'resolved') return customer;
    const subject = await this.resolveSubject({
      customer: customer.customer,
      petName: input.subjectName,
    });
    if (subject.kind !== 'resolved') return subject;
    return {
      kind: 'resolved',
      party: {
        customer: {
          displayName: customer.customer.displayName,
          providerKey: customer.customer.key,
          trustedPhoneE164: input.trustedCallerE164,
        },
        subject: { displayName: subject.subject.displayName, providerKey: subject.subject.key },
      },
    };
  }
}
