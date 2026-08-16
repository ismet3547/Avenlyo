import { z } from 'zod';

import { industryIds } from './types';

export const industryIdSchema = z.enum(industryIds);

export const industrySelectionSchema = z.object({
  industryId: industryIdSchema,
});
