export interface FormActionState {
  fieldErrors?: Record<string, string[] | undefined>;
  message?: string;
  status: 'idle' | 'error' | 'success';
}

export const initialFormActionState: FormActionState = { status: 'idle' };
