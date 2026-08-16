import { z } from 'zod';

export const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof weekdays)[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time.');

const openDaySchema = z
  .object({
    closed: z.literal(false),
    open: timeSchema,
    close: timeSchema,
  })
  .superRefine((value, context) => {
    if (value.close <= value.open) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Closing time must be later than opening time.',
        path: ['close'],
      });
    }
  });

const closedDaySchema = z.object({
  closed: z.literal(true),
  open: z.null(),
  close: z.null(),
});

export const businessDaySchema = z.union([openDaySchema, closedDaySchema]);

export const businessHoursSchema = z.object({
  monday: businessDaySchema,
  tuesday: businessDaySchema,
  wednesday: businessDaySchema,
  thursday: businessDaySchema,
  friday: businessDaySchema,
  saturday: businessDaySchema,
  sunday: businessDaySchema,
});

function emptyStringToUndefined(value: unknown) {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

export function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  const prefix = trimmed.startsWith('+') ? '+' : '';
  return `${prefix}${trimmed.replace(/\D/g, '')}`;
}

const websiteSchema = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .url('Enter a valid website URL.')
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'Website URL must start with http:// or https://.',
    })
    .optional(),
);

const phoneSchema = z.preprocess(
  (value) => {
    const normalized = emptyStringToUndefined(value);
    return typeof normalized === 'string' ? normalizePhoneNumber(normalized) : normalized;
  },
  z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/, 'Enter a valid phone number, including country code.')
    .optional(),
);

export const businessDetailsSchema = z.object({
  name: z.string().trim().min(1, 'Business name is required.').max(120),
  websiteUrl: websiteSchema,
  phone: phoneSchema,
});

export const locationDetailsSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required.').max(120),
  street: z.string().trim().min(1, 'Street address is required.').max(200),
  city: z.string().trim().min(1, 'City is required.').max(120),
  region: z.string().trim().min(1, 'State or region is required.').max(120),
  postalCode: z.string().trim().min(1, 'Postal code is required.').max(24),
  countryCode: z
    .string()
    .trim()
    .length(2, 'Use a two-letter ISO country code.')
    .transform((value) => value.toUpperCase()),
  timezone: z
    .string()
    .trim()
    .min(1, 'Timezone is required.')
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value }).format();
          return value.includes('/');
        } catch {
          return false;
        }
      },
      { message: 'Choose a valid IANA timezone.' },
    ),
  businessHours: businessHoursSchema,
});

export const websitePreviewSchema = z.object({
  acknowledgement: z.literal('continue'),
});

export const onboardingCompletionSchema = z.object({
  intent: z.literal('complete'),
});

export type BusinessDay = z.infer<typeof businessDaySchema>;
export type BusinessHours = z.infer<typeof businessHoursSchema>;
export type BusinessDetails = z.infer<typeof businessDetailsSchema>;
export type LocationDetails = z.infer<typeof locationDetailsSchema>;
