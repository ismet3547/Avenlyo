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
import { record, string } from './schemas';
import type { EzyVetCatalogConnector, EzyVetSite } from './types';

function siteFromPayload(value: unknown): EzyVetSite {
  const root = record(value);
  const source = record(root.siteInformation ?? root.site ?? root.data ?? root);
  const id = string(source.uid ?? source.id);
  const timezone = string(source.timezone ?? source.time_zone);
  if (!id || !timezone) throw new Error('ezyVet site information was incomplete.');
  return { id, timezone };
}

export class EzyVetConnector implements BookingConnector, EzyVetCatalogConnector {
  public readonly provider = 'ezyvet' as const;

  public constructor(private readonly client: EzyVetClient) {}

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
    return siteFromPayload(await this.client.get('/v3/siteInformation'));
  }

  public async resolveCustomer(input: CustomerResolutionRequest): Promise<CustomerResolution> {
    return resolveExactPhoneCustomer(this.client, input.trustedCallerE164);
  }

  public async resolveSubject(input: SubjectResolutionRequest): Promise<SubjectResolution> {
    return resolveOwnedAnimal(this.client, input.customer, input.petName);
  }
}
